export const REPO = "https://github.com/TheM1N9/perry";
export const INSTALL_GUIDE = `${REPO}/blob/main/INSTALL.md`;
/** Where the site is served: Vercel's production domain when deployed there. */
export const SITE = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : "http://localhost:3000";
