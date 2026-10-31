// The TeamLink logo on every invoice copy (founder 2026-10-31: "invoices view lo TeamLink logo add cheyyi, invoice bills
// lo"). The company's own uploaded logo (Company.logoUrl) wins when there is one; otherwise this artwork - the same file
// the app header, payslips and certificates use. A full address, so it also loads in the print pop-up and the preview frame.
import logo from '../../assets/teamlink-full-logo.png';

export const INVOICE_LOGO = new URL(logo, window.location.href).href;
