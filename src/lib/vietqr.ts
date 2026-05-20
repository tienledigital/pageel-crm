/**
 * Removes Vietnamese accents and special characters to generate a safe string for VietQR/SePay API
 */
export const removeAccents = (str: string): string => {
  return str
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9 ]/g, ''); // Remove special characters to avoid breaking API URL
};

/**
 * Generates a VietQR string according to SePay/VietQR format
 * Template types: compact, compact2, qr_only, logo
 */
export const generateSePayQR = (
  data: { amount: number; description: string; bankCode: string; accountNumber: string },
  template: string = 'compact2'
): string => {
  const { bankCode, accountNumber, amount, description } = data;
  return `https://img.vietqr.io/image/${bankCode}-${accountNumber}-${template}.png?amount=${amount}&addInfo=${encodeURIComponent(description)}`;
};
