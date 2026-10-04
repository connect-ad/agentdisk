/**
 * The company behind the product.
 *
 * AgentDisk is the brand; Kernelv5 Inc. is the legal entity that sells it,
 * and the name a customer sees on Stripe's checkout page and on their card
 * statement. Every place the site names the company reads from here, so the
 * footer, the header byline, the auth sheet, the Terms and the billing page
 * cannot spell it three different ways.
 *
 * Plain JavaScript with no imports, like `seo.js`: the prerender imports the
 * marketing routes under Node, outside Vite, so nothing here may touch a
 * browser global or `import.meta.env`.
 *
 * Kernelv5 has no logo. The byline is a text wordmark on purpose, not an
 * image waiting for an asset that does not exist.
 */

export const COMPANY_NAME = 'Kernelv5';
export const COMPANY_LEGAL_NAME = 'Kernelv5 Inc.';
export const COMPANY_URL = 'https://kernelv5.com/';
export const COMPANY_BYLINE = 'A product by';
