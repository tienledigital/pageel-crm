/**
 * Remove Vietnamese accents and special characters
 */
export function removeAccents(str: string): string {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9 ]/g, '');
}

/**
 * Generate the standard banking QR memo string
 */
export function generateQrMemo(
  customerId: string,
  customerName: string,
  serviceName: string,
  period: number
): string {
  if (!customerId) return '';
  const namePart = removeAccents(customerName).toUpperCase();
  const servicePart = removeAccents(serviceName).toUpperCase();
  let memo = `${customerId} - ${namePart}`;
  if (servicePart) {
    memo += ` - ${servicePart}`;
  }
  if (period > 1) {
    memo += ` X${period}`;
  }
  return memo;
}

/**
 * Calculate final amount based on base price and periods multiplier
 */
export function calculateQrAmount(basePrice: number, period: number): number {
  return (basePrice || 0) * (period || 1);
}
