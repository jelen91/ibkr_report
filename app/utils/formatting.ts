export const formatCurrency = (val: number, fractionDigits = 0) => {
    return Number(val).toLocaleString('cs-CZ', { maximumFractionDigits: fractionDigits }) + ' CZK';
};

export const formatDate = (dateStr: string) => {
    if (!dateStr || dateStr.length !== 8) return dateStr;
    return `${dateStr.substring(6, 8)}.${dateStr.substring(4, 6)}.${dateStr.substring(0, 4)}`;
};

export const parseExpiryDate = (expiry: string | number | undefined) => {
    if (!expiry) return 0;
    const s = String(expiry);
    // If YYYYMMDD (numeric or string without dots)
    if (!s.includes('.')) {
        if (s.length === 8) {
            return new Date(`${s.substring(0, 4)}-${s.substring(4, 6)}-${s.substring(6, 8)}`).getTime();
        }
        return 0;
    }
    // If DD.MM.YYYY
    return new Date(s.split('.').reverse().join('-')).getTime();
};
