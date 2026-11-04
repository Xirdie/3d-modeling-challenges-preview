window.STUDIO_PREVIEW = true;
// CritPass public configuration. Public values only: no secret ever goes in this file.
// /ship (and /preview) edit one line per constant.
const PAYMENT_LINKS = {"one_off": "", "pack": "", "monthly": "", "deep": ""}; // filled by /ship from stripe_api.py create; an empty entry disables its button; empty deep hides every data-requires="deep" element
const WORKER_URL = "https://3d-modeling-challenges-preview.icro-aa.workers.dev"; // filled by /ship (the deployed Worker); empty = every review and pay button disabled
const PORTAL_URL = "https://billing.stripe.com/p/login/00w5kCbck3583pQfGLb7y00"; // integrations.stripe.customer_portal_url
const ANALYTICS_TOKEN = ""; // integrations.cloudflare.web_analytics_token (public beacon token); "" = no beacon
const TURNSTILE_SITE_KEY = "1x00000000000000000000AA"; // Cloudflare's documented always-pass TEST site key; /preview and /ship replace it from integrations.cloudflare.turnstile_site_key
const HUB_URL = "https://tools.xirdie.com/";
const CONTACT_EMAIL = "business@xirdie.com";
