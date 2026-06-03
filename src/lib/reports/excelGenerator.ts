// @para-doc [tax-reporting-spec.md#excel-generation-algorithm]
import JSZip from 'jszip';

// @para-doc [tax-reporting-spec.md#excel-generation-algorithm]
export interface ExportPayment {
  paidAt: number; // Unix timestamp in milliseconds
  amount: number;
  type: string; // 'in' or 'out'
  content: string; // Raw description
  customer?: {
    id: string;
    fullName: string;
  } | null;
  invoice?: {
    id: string;
    invoiceNumber: string;
    content: string;
  } | null;
}

// @para-doc [tax-reporting-spec.md#remove-accents]
const removeAccents = (str: string): string => {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
};

// @para-doc [tax-reporting-spec.md#sanitize-formula]
const sanitizeFormula = (value: string | null | undefined): string => {
  if (!value) return '';
  const firstChar = value.charAt(0);
  if (['=', '+', '-', '@'].includes(firstChar)) {
    return `'${value}`;
  }
  return value;
};

// @para-doc [tax-reporting-spec.md#get-payment-description]
const getPaymentDescription = (payment: ExportPayment): string => {
  if (payment.customer) {
    const id = payment.customer.id;
    const name = removeAccents(payment.customer.fullName);
    const service = payment.invoice ? removeAccents(payment.invoice.content) : 'TT GIA HAN';
    return `${id} - ${name} - ${service}`;
  }
  if (payment.invoice) {
    return `INVOICE ${payment.invoice.invoiceNumber} - ${removeAccents(payment.invoice.content)}`;
  }
  return payment.content ? removeAccents(payment.content) : 'KHACH VANG LAI - THANH TOAN';
};

/**
 * Lazily load ExcelJS with process.umask polyfill.
 * ExcelJS calls process.umask() during module initialization which fails
 * in Cloudflare Workers / unenv runtime. By using dynamic import, the module
 * is only loaded when actually needed (at request time), not during SSR route
 * resolution. The polyfill is applied right before import.
 */
// @para-doc [infrastructure.md#exceljs]
const loadExcelJS = async () => {
  // Polyfill process.umask before ExcelJS module initialization
  if (typeof process !== 'undefined') {
    try {
      // Use Object.defineProperty to override unenv's read-only getter for process.umask
      Object.defineProperty(process, 'umask', {
        value: () => 0o022,
        writable: true,
        configurable: true,
      });
    } catch (e) {
      // Fallback to direct assignment if defineProperty fails
      try {
        (process as any).umask = () => 0o022;
      } catch (err) {
        // Ignore if completely frozen
      }
    }
  }
  const ExcelJS = await import('exceljs');
  return (ExcelJS as any).default || ExcelJS;
};

// @para-doc [tax-reporting-spec.md#excel-generation-algorithm]
export const generateS1a = async (templateBuffer: ArrayBuffer, payments: ExportPayment[]): Promise<ArrayBuffer> => {
  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer);
  
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('Template is empty or invalid.');
  }

  // Force Excel to calculate formulas on load
  if (!workbook.calcProperties) {
    workbook.calcProperties = { fullCalcOnLoad: true } as any;
  } else {
    workbook.calcProperties.fullCalcOnLoad = true;
  }

  // Unmerge 'Ghi chú' to prevent it from being corrupted or pushed down weirdly
  try {
    worksheet.unMergeCells('G9:I13');
    worksheet.mergeCells('G9:I11');
    ['G12', 'H12', 'I12', 'G13', 'H13', 'I13'].forEach(c => {
      const cell = worksheet.getCell(c);
      if (cell) cell.value = null;
    });
  } catch (e) {
    // ignore if not merged
  }

  // Insert rows starting at row 12
  const startRow = 12;
  let currentRow = startRow;

  // Only get incoming payments
  const incomingPayments = payments.filter(p => p.type === 'in');

  for (let i = 0; i < incomingPayments.length; i++) {
    const payment = incomingPayments[i];
    
    // If we exceed the template's placeholder rows (rows 12-18), insert new rows.
    // Otherwise, overwrite existing rows to avoid shifting merged cells below.
    if (currentRow >= 19) {
      worksheet.insertRow(currentRow, []);
    }
    const row = worksheet.getRow(currentRow);
    
    // 3 columns: Document date (B), Description (C), Revenue (D)
    // format date: YYYY-MM-DD
    const dateStr = new Date(payment.paidAt).toISOString().split('T')[0];
    row.getCell(2).value = dateStr;
    row.getCell(3).value = sanitizeFormula(getPaymentDescription(payment));
    row.getCell(4).value = payment.amount;

    // Apply basic styles for columns 2, 3, 4
    for (let col = 2; col <= 4; col++) {
      const cell = row.getCell(col);
      const currentStyle = cell.style || {};
      cell.style = {
        ...currentStyle,
        border: {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' }
        },
        font: { name: 'Times New Roman', size: 12 }
      };
    }

    currentRow++;
  }

  // Live Formula for Totals row
  const totalRow = worksheet.getRow(currentRow);
  totalRow.getCell(3).value = 'Tổng cộng:';
  totalRow.getCell(3).font = { bold: true, name: 'Times New Roman', size: 12 };

  const totalAmount = incomingPayments.reduce((sum, p) => sum + (p.amount || 0), 0);

  if (incomingPayments.length > 0) {
    const formulaStr = `SUM(D${startRow}:D${currentRow - 1})`;
    totalRow.getCell(4).value = { formula: formulaStr, result: totalAmount } as any;
  } else {
    totalRow.getCell(4).value = 0;
  }
  
  totalRow.getCell(4).font = { bold: true, name: 'Times New Roman', size: 12 };

  // Delete surplus rows (including old "Totals") between the data table and the signature block
  let signatureRow = -1;
  for (let r = currentRow + 1; r <= currentRow + 30; r++) {
    const row = worksheet.getRow(r);
    let foundSignature = false;
    row.eachCell({ includeEmpty: true }, (cell: any) => {
      const val = cell.value?.toString() || '';
      if (val.includes('Ngày') && val.includes('tháng') && val.includes('năm')) {
        foundSignature = true;
      }
    });
    if (foundSignature) {
      signatureRow = r;
      break;
    }
  }

  if (signatureRow !== -1) {
    const rowsToDelete = signatureRow - (currentRow + 1);
    if (rowsToDelete > 1) {
      // Keep 1 blank row between the data table and the signature
      worksheet.spliceRows(currentRow + 1, rowsToDelete - 1);
    }
  } else {
    // Fallback: Delete 7 surplus rows based on default template structure
    worksheet.spliceRows(currentRow + 1, 7);
  }

  const buffer = await workbook.xlsx.writeBuffer();
  
  if (buffer instanceof ArrayBuffer) {
    return buffer;
  }
  
  // Convert Node.js Buffer to ArrayBuffer
  const uint8Array = new Uint8Array(buffer as any);
  return uint8Array.buffer.slice(uint8Array.byteOffset, uint8Array.byteOffset + uint8Array.byteLength) as ArrayBuffer;
};

// @para-doc [tax-reporting-spec.md#zip]
export const exportYearlyS1aZip = async (
  payments: ExportPayment[],
  year: number,
  templateBuffer: ArrayBuffer,
  onProgress?: (percent: number) => void
): Promise<Blob> => {
  const zip = new JSZip();

  // Generate reports for 12 months
  for (let month = 1; month <= 12; month++) {
    // Filter payments by month/year
    const monthPayments = payments.filter(p => {
      const date = new Date(p.paidAt);
      const pYear = date.getUTCFullYear();
      const pMonth = date.getUTCMonth() + 1; // 0-indexed
      return pYear === year && pMonth === month;
    });

    // Still generate file even if no transactions (monthPayments is empty)
    const buffer = await generateS1a(templateBuffer, monthPayments);
    
    // Add to zip archive
    const monthStr = month.toString().padStart(2, '0');
    zip.file(`S1a-HKD_Thang_${monthStr}_${year}.xlsx`, buffer);
    
    // Update progress
    if (onProgress) {
      onProgress(Math.round((month / 12) * 100));
    }
  }

  // Compress into a Blob
  const blob = await zip.generateAsync({ type: 'blob' });
  return blob;
};
