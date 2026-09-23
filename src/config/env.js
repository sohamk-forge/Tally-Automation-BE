export const PORT = process.env.PORT || 5001;

// Fallback server address used when API_DOMAIN / FRONTEND_URL aren't set.
export const DEFAULT_STATIC_IP = "43.241.135.138";

// Getters read process.env at call time, so they still pick up .env values
// in scripts that call dotenv.config() after their imports are evaluated.
export const getStaticIp = () => process.env.STATIC_IP || DEFAULT_STATIC_IP;

export const getApiDomain = () =>
  process.env.API_DOMAIN || `http://${getStaticIp()}:${process.env.PORT || 5001}`;

export const getFrontendUrl = () =>
  process.env.FRONTEND_URL || `http://${getStaticIp()}:5173`;
