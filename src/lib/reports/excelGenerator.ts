// @para-doc [tax-reporting-spec.md#4-thuat-toan-dien-du-lieu-template-s1a-excel-generation-algorithm]
import JSZip from 'jszip';
import { getDb } from '@/lib/db';
import { config as dbConfigTable } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { env } from 'cloudflare:workers';

// @para-doc [tax-reporting-spec.md#21-so-do-du-lieu-ket-xuat-data-export-schema]
export interface ExportPayment {
  paidAt: number; // Unix timestamp in milliseconds
  amount: number;
  type: string; // 'in' or 'out'
  content: string; // Raw description
  customer?: {
    id: string;
    fullName: string;
  } | null;
  order?: {
    id: string;
    orderNumber: string;
    content: string;
    taxInvoiceNumber?: string | null;
    taxInvoiceDate?: number | null;
  } | null;
  serviceName?: string | null;
  serviceDescription?: string | null;
}

// @para-doc [tax-reporting-spec.md#32-lam-sach-cong-thuc-excel-sanitizeformula]
const sanitizeFormula = (value: string | null | undefined): string => {
  if (!value) return '';
  const firstChar = value.charAt(0);
  if (['=', '+', '-', '@'].includes(firstChar)) {
    return `'${value}`;
  }
  return value;
};

// @para-doc [tax-reporting-spec.md#33-tu-dong-chuan-hoa-noi-dung-dien-giai-getpaymentdescription]
const formatDateUTC = (timestamp: number, formatStr: string): string => {
  const d = new Date(timestamp);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const date = String(d.getUTCDate()).padStart(2, '0');
  
  return formatStr
    .replace('YYYY', String(year))
    .replace('MM', month)
    .replace('DD', date)
    .replace('YYYY', String(year))
    .replace('mm', month)
    .replace('dd', date);
};

// @para-doc [tax-reporting-spec.md#33-tu-dong-chuan-hoa-noi-dung-dien-giai-getpaymentdescription]
export const getPaymentDescription = (payment: ExportPayment, config: any): string => {
  const placeholders = {
    customerId: payment.customer?.id || null,
    customerName: payment.customer?.fullName || null,
    serviceName: payment.serviceName || (payment.order ? payment.order.content : 'TT GIA HAN'),
    serviceDescription: payment.serviceDescription || null,
    orderNumber: payment.order?.orderNumber || null,
    orderContent: payment.order?.content || null,
    rawContent: payment.content || null
  };

  if (payment.customer) {
    return parseReportTemplate(config.serviceTemplate || '{customerId} - {customerName} - {serviceName}', placeholders);
  }
  if (payment.order) {
    return parseReportTemplate(config.orderTemplate || 'ORDER {orderNumber} - {orderContent}', placeholders);
  }
  return payment.content ? payment.content : 'KHACH VANG LAI - THANH TOAN';
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
  // @ts-ignore
  const ExcelJS = await import('exceljs/dist/exceljs.bare.js');
  return (ExcelJS as any).default || ExcelJS;
};

// @para-doc [tax-reporting-spec.md#42-cac-buoc-dien-du-lieu-excel-generation-steps]
export const generateS1a = async (templateBuffer: ArrayBuffer, payments: ExportPayment[], config?: any): Promise<ArrayBuffer> => {
  const ExcelJS = await loadExcelJS();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(templateBuffer);
  
  const worksheet = workbook.worksheets[0];
  if (!worksheet) {
    throw new Error('Template is empty or invalid.');
  }

  // Load and apply configurations
  let activeConfig = {
    orgName: 'HỘ KINH DOANH',
    mst: '',
    address: '',
    businessLocation: '',
    reportingPeriod: '',
    serviceTemplate: '{customerId} - {customerName} - {serviceName}',
    orderTemplate: 'ORDER {orderNumber} - {orderContent}',
    dateFormat: 'DD/MM/YYYY'
  };

  if (config) {
    activeConfig = { ...activeConfig, ...config };
  } else {
    try {
      const db = getDb(env);
      const dbRows = await db.select().from(dbConfigTable).where(eq(dbConfigTable.key, 'report_config_s1a')).limit(1);
      if (dbRows.length > 0) {
        const parsed = JSON.parse(dbRows[0].value);
        activeConfig = { ...activeConfig, ...parsed };
      }
    } catch (e) {
      // Fail silently and use default configurations
    }
  }

  // Dynamically write HKD profile (Name, MST, Address) into headers
  const cellA1 = worksheet.getCell('A1');
  if (cellA1) {
    cellA1.value = `HỘ, CÁ NHÂN KINH DOANH: ${activeConfig.orgName || ''}`;
  }
  const cellA2 = worksheet.getCell('A2');
  if (cellA2) {
    cellA2.value = `Địa chỉ: ${activeConfig.address || ''}`;
  }
  const cellA3 = worksheet.getCell('A3');
  if (cellA3) {
    cellA3.value = `Mã số thuế: ${activeConfig.mst || ''}`;
  }

  const cellB7 = worksheet.getCell('B7');
  if (cellB7) {
    cellB7.value = `Địa điểm kinh doanh: ${activeConfig.businessLocation || ''}`;
  }
  const cellB8 = worksheet.getCell('B8');
  if (cellB8) {
    cellB8.value = `Kỳ kê khai: ${activeConfig.reportingPeriod || ''}`;
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
    const dateStr = formatDateUTC(payment.paidAt, activeConfig.dateFormat || 'DD/MM/YYYY');
    row.getCell(2).value = dateStr;
    row.getCell(3).value = sanitizeFormula(getPaymentDescription(payment, activeConfig));
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

// @para-doc [tax-reporting-spec.md#5-xuat-bao-cao-zip-va-quan-ly-phan-trang-api]
export const exportYearlyS1aZip = async (
  payments: ExportPayment[],
  year: number,
  templateBuffer: ArrayBuffer,
  config?: any,
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
    const buffer = await generateS1a(templateBuffer, monthPayments, config);
    
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

// @para-doc [tax-reporting-spec.md#33-tu-dong-chuan-hoa-noi-dung-dien-giai-getpaymentdescription]
export function parseReportTemplate(
  template: string,
  placeholders: {
    customerId?: string | null;
    customerName?: string | null;
    serviceName?: string | null;
    serviceDescription?: string | null;
    orderNumber?: string | null;
    orderContent?: string | null;
    rawContent?: string | null;
  },
): string {
  // 1. Replace placeholders of format {key}
  let result = template.replace(/\{(\w+)\}/g, (match, key) => {
    const value = placeholders[key as keyof typeof placeholders];
    return value !== undefined && value !== null ? String(value) : "";
  });

  // 2. Clean up duplicate or trailing separators and collapse extra whitespaces
  result = result
    .replace(/\s*-\s*-\s*/g, " - ") // Collapse consecutive hyphen separators
    .replace(/^\s*-\s*/, "")        // Remove leading hyphen
    .replace(/\s*-\s*$/, "")        // Remove trailing hyphen
    .replace(/\s+/g, " ")           // Collapse duplicate spaces
    .trim();

  return result || "KHÁCH VÃNG LAI - THANH TOÁN";
}

