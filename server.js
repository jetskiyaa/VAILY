require("dotenv").config();

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const https = require("https");
const util = require("util");
const { Auth, AuthInstance } = require("@valapi/auth");
const { WebClient } = require("@valapi/web-client");

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const REGION = process.env.VAL_REGION || "ap";
const RIOT_BROWSER_AUTH_URL = "https://auth.riotgames.com/authorize?redirect_uri=https%3A%2F%2Fplayvalorant.com%2Fopt_in&client_id=play-valorant-web-prod&response_type=token%20id_token&nonce=1&scope=account%20openid";
const STORE_REGIONS = ["ap", "eu", "na", "kr", "latam", "br", "pbe"];
const execFileAsync = util.promisify(execFile);
const CURL_BIN = process.platform === "win32" ? "curl.exe" : "curl";
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || ""));
const RIOT_LOCKFILE_PATH = path.join(
    process.env.LOCALAPPDATA || "",
    "Riot Games",
    "Riot Client",
    "Config",
    "lockfile"
);
let apiMetadataPromise = null;
let skinDatabasePromise = null;
let currencyDatabasePromise = null;
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;

function getLevelNumberFromAssetPath(assetPath) {
    const match = assetPath && assetPath.match(/_Lv(\d+)_/i);
    return match ? Number(match[1]) : null;
}

function buildLevelLabel(levelNumber, fallbackIndex) {
    const numericLevel = Number.isFinite(levelNumber) ? levelNumber : fallbackIndex + 1;
    return `Lv${numericLevel}`;
}

async function loadSkinDatabase() {
    if (!skinDatabasePromise) {
        skinDatabasePromise = axios
            .get("https://valorant-api.com/v1/weapons/skins", { timeout: 20000 })
            .then((response) => {
                const database = new Map();

                for (const skin of response.data.data || []) {
                    const baseName = skin.displayName || "Unknown Skin";
                    const baseIcon = skin.displayIcon || null;
                    const tierUuid = skin.contentTierUuid || null;
                    const levels = (skin.levels || []).map((level, index) => {
                        const levelNumber = getLevelNumberFromAssetPath(level.assetPath);
                        return {
                            id: level.uuid,
                            name: level.displayName || baseName,
                            shortLabel: buildLevelLabel(levelNumber, index),
                            levelNumber: levelNumber ?? index + 1,
                            icon: level.displayIcon || baseIcon,
                            video: level.streamedVideo || null,
                            assetPath: level.assetPath || null
                        };
                    });
                    const defaultLevel = levels[0] || null;
                    const variants = (skin.chromas || []).map((chroma, index) => ({
                        id: chroma.uuid,
                        name: chroma.displayName || (index === 0 ? "Default" : `Variant ${index + 1}`),
                        icon: chroma.fullRender || chroma.displayIcon || baseIcon,
                        video: chroma.streamedVideo || null
                    }));
                    const preview = {
                        skinId: skin.uuid,
                        baseName,
                        defaultLevelId: defaultLevel?.id || null,
                        defaultVariantId: variants[0]?.id || null,
                        levels: levels.length
                            ? levels
                            : [
                                {
                                    id: skin.uuid,
                                    name: baseName,
                                    shortLabel: "Lv1",
                                    levelNumber: 1,
                                    icon: baseIcon,
                                    video: null,
                                    assetPath: skin.assetPath || null
                                }
                            ],
                        variants: variants.length
                            ? variants
                            : [
                                {
                                    id: skin.uuid,
                                    name: "Default",
                                    icon: baseIcon,
                                    video: null
                                }
                            ]
                    };

                    if (skin.uuid) {
                        database.set(skin.uuid, {
                            name: baseName,
                            icon: baseIcon,
                            tierUuid,
                            preview
                        });
                    }

                    for (const level of skin.levels || []) {
                        if (!level.uuid) {
                            continue;
                        }

                        const matchedLevel = levels.find((entry) => entry.id === level.uuid);
                        const levelName = matchedLevel
                            ? `${matchedLevel.name} (${matchedLevel.shortLabel})`
                            : (level.displayName || baseName);

                        database.set(level.uuid, {
                            name: levelName,
                            icon: level.displayIcon || baseIcon,
                            tierUuid,
                            preview: {
                                ...preview,
                                defaultLevelId: matchedLevel?.id || preview.defaultLevelId
                            }
                        });
                    }

                    for (const chroma of skin.chromas || []) {
                        if (!chroma.uuid) {
                            continue;
                        }

                        const matchedVariant = variants.find((entry) => entry.id === chroma.uuid);

                        database.set(chroma.uuid, {
                            name: chroma.displayName || baseName,
                            icon: chroma.fullRender || chroma.displayIcon || baseIcon,
                            tierUuid,
                            preview: {
                                ...preview,
                                defaultVariantId: matchedVariant?.id || preview.defaultVariantId
                            }
                        });
                    }
                }

                return database;
            })
            .catch((error) => {
                skinDatabasePromise = null;
                throw error;
            });
    }

    return skinDatabasePromise;
}

async function loadCurrencyDatabase() {
    if (!currencyDatabasePromise) {
        currencyDatabasePromise = axios
            .get("https://valorant-api.com/v1/currencies", { timeout: 20000 })
            .then((response) => {
                const database = new Map();

                for (const currency of response.data.data || []) {
                    database.set(currency.uuid, {
                        id: currency.uuid,
                        name: currency.displayName,
                        singular: currency.displayNameSingular,
                        icon: currency.displayIcon || currency.largeIcon || null
                    });
                }

                return database;
            })
            .catch((error) => {
                currencyDatabasePromise = null;
                throw error;
            });
    }

    return currencyDatabasePromise;
}

const TIER_STYLES = {
    "12683d76-48d7-84a3-4e09-6985794f0445": { rarity: "Select", color: "#6db7ff" },
    "0cebb8be-46d7-c12a-d306-e9907bfc5a25": { rarity: "Deluxe", color: "#59d8a7" },
    "60bca009-4182-7998-dee7-b8a2558dc369": { rarity: "Premium", color: "#ff6fd8" },
    "e046854e-406c-37f4-6607-19a9ba8426fc": { rarity: "Exclusive", color: "#f0a35e" },
    "411e4a55-4e59-7757-41f0-86a53f101bb5": { rarity: "Ultra", color: "#f3df6c" }
};

function getTierStyle(tierUuid) {
    return TIER_STYLES[tierUuid] || { rarity: "Featured", color: "#ff4655" };
}

function pluralizeLabel(label, amount) {
    if (!label) {
        return amount === 1 ? "Item" : "Items";
    }

    if (amount === 1) {
        return label;
    }

    return label.endsWith("s") ? label : `${label}s`;
}

function formatDuration(seconds) {
    const totalSeconds = Math.max(0, Number(seconds) || 0);
    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);

    if (days > 0) {
        return `${days}d ${hours}h`;
    }

    if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }

    return `${minutes}m`;
}

function setNoStore(res) {
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
}

function getRequestIp(req) {
    const forwarded = req.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
        return forwarded.split(",")[0].trim();
    }

    return req.socket?.remoteAddress || "unknown";
}

function createRateLimiter({ windowMs, maxRequests }) {
    return (req, res, next) => {
        const key = `${req.path}:${getRequestIp(req)}`;
        const now = Date.now();
        const entry = rateLimitStore.get(key);

        if (!entry || now - entry.startedAt >= windowMs) {
            rateLimitStore.set(key, { startedAt: now, count: 1 });
            next();
            return;
        }

        if (entry.count >= maxRequests) {
            setNoStore(res);
            res.status(429).json({
                ok: false,
                error: "Too many requests. Please wait a minute and try again."
            });
            return;
        }

        entry.count += 1;
        next();
    };
}

function validateRiotRedirectUrl(redirectUrl) {
    let parsed;
    try {
        parsed = new URL(String(redirectUrl || "").trim());
    } catch (_error) {
        throw new Error("Redirect URL is not valid.");
    }

    const allowedHosts = new Set(["playvalorant.com", "www.playvalorant.com"]);
    if (!allowedHosts.has(parsed.hostname)) {
        throw new Error("Redirect URL must come from playvalorant.com.");
    }

    if (!parsed.hash.includes("access_token=")) {
        throw new Error("The URL must include #access_token=... from the Riot redirect.");
    }

    return parsed.toString();
}

function getCommonPrefix(values) {
    if (!values.length) {
        return "";
    }

    let prefix = values[0];

    for (const value of values.slice(1)) {
        while (prefix && !value.startsWith(prefix)) {
            prefix = prefix.slice(0, -1);
        }
    }

    return prefix.trim();
}

function getReadableError(error) {
    const riotError = error.response?.data?.error || error.data?.data?.error;
    const country = error.response?.data?.country || error.data?.data?.country;

    if (riotError === "invalid_request") {
        return country
            ? `Riot blocked username/password login for this session in ${country.toUpperCase()}. Use VAL_SSID from an already logged-in browser session.`
            : "Riot blocked username/password login for this session. Use VAL_SSID from an already logged-in browser session.";
    }

    if (error.message?.includes("MFA")) {
        return error.message;
    }

    if (error.cause?.message) {
        return `${error.message}: ${error.cause.message}`;
    }

    return error.message || "Failed to fetch store.";
}

function applyCookieString(auth, cookieString) {
    const parts = String(cookieString || "")
        .split(";")
        .map((part) => part.trim())
        .filter(Boolean);

    for (const part of parts) {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex <= 0) {
            continue;
        }

        const key = part.slice(0, separatorIndex).trim();
        const value = part.slice(separatorIndex + 1).trim();

        if (!key || !value) {
            continue;
        }

        auth.cookie.setCookieSync(
            `${key}=${value}; Domain=riotgames.com; Path=/; Secure; HttpOnly`,
            "https://auth.riotgames.com"
        );
    }
}

function parseRedirectTokens(redirectUrl) {
    const normalizedUrl = String(redirectUrl || "").trim();
    const hashIndex = normalizedUrl.indexOf("#");

    if (hashIndex === -1) {
        throw new Error("The URL must include a #access_token=... fragment.");
    }

    const fragment = normalizedUrl.slice(hashIndex + 1);
    const params = new URLSearchParams(fragment);
    const accessToken = params.get("access_token");
    const idToken = params.get("id_token");
    const sessionState = params.get("session_state") || "";

    if (!accessToken || !idToken) {
        throw new Error("The redirect URL is missing access_token or id_token.");
    }

    return {
        accessToken,
        idToken,
        sessionState
    };
}

async function loadApiMetadata() {
    if (!apiMetadataPromise) {
        apiMetadataPromise = (async () => {
            const endpoints = [
                "https://valorant-api.com/v1/bundles",
                "https://valorant-api.com/v1/playercards",
                "https://valorant-api.com/v1/buddies",
                "https://valorant-api.com/v1/buddies/levels",
                "https://valorant-api.com/v1/sprays",
                "https://valorant-api.com/v1/sprays/levels",
                "https://valorant-api.com/v1/playertitles"
            ];
            const responses = await Promise.all(endpoints.map((url) => axios.get(url, { timeout: 20000 })));
            const [
                bundlesResponse,
                playerCardsResponse,
                buddiesResponse,
                buddyLevelsResponse,
                spraysResponse,
                sprayLevelsResponse,
                titlesResponse
            ] = responses;

            const bundleMap = new Map();
            for (const bundle of bundlesResponse.data.data || []) {
                bundleMap.set(bundle.uuid, {
                    name: bundle.displayName,
                    icon: bundle.displayIcon2 || bundle.verticalPromoImage || bundle.displayIcon || null
                });
            }

            const itemMap = new Map();

            for (const card of playerCardsResponse.data.data || []) {
                itemMap.set(card.uuid, {
                    name: card.displayName,
                    icon: card.wideArt || card.largeArt || card.displayIcon || null,
                    type: "Player Card"
                });
            }

            for (const buddy of buddiesResponse.data.data || []) {
                itemMap.set(buddy.uuid, {
                    name: buddy.displayName,
                    icon: buddy.displayIcon || null,
                    type: "Buddy"
                });
            }

            for (const level of buddyLevelsResponse.data.data || []) {
                itemMap.set(level.uuid, {
                    name: `${level.displayName} Buddy`,
                    icon: level.displayIcon || null,
                    type: "Buddy"
                });
            }

            for (const spray of spraysResponse.data.data || []) {
                itemMap.set(spray.uuid, {
                    name: spray.displayName,
                    icon: spray.fullTransparentIcon || spray.fullIcon || spray.displayIcon || null,
                    type: "Spray"
                });
            }

            for (const level of sprayLevelsResponse.data.data || []) {
                itemMap.set(level.uuid, {
                    name: level.displayName,
                    icon: level.displayIcon || null,
                    type: "Spray"
                });
            }

            for (const title of titlesResponse.data.data || []) {
                itemMap.set(title.uuid, {
                    name: title.displayName,
                    icon: null,
                    type: "Title"
                });
            }

            return {
                bundles: bundleMap,
                items: itemMap
            };
        })().catch((error) => {
            apiMetadataPromise = null;
            throw error;
        });
    }

    return apiMetadataPromise;
}

function getOfferPrice(cost, currencyDatabase) {
    const [currencyId, amount] = Object.entries(cost || {})[0] || [null, 0];
    const currency = currencyDatabase.get(currencyId) || {
        id: currencyId,
        name: "Unknown Currency",
        singular: "Currency",
        icon: null
    };

    return {
        currencyId,
        amount: amount || 0,
        currencyName: currency.name,
        currencyIcon: currency.icon,
        label: currency.name === "VALORANT POINTS"
            ? "VP"
            : currency.name === "Kingdom Credits"
                ? "KC"
                : currency.singular || currency.name
    };
}

function resolveItemMetadata(itemId, skinDatabase, apiMetadata) {
    const skin = skinDatabase.get(itemId);
    if (skin) {
        return {
            name: skin.name,
            icon: skin.icon,
            type: "Skin",
            tierUuid: skin.tierUuid,
            preview: skin.preview || null
        };
    }

    const item = apiMetadata.items.get(itemId);
    if (item) {
        return {
            name: item.name,
            icon: item.icon,
            type: item.type || "Item",
            tierUuid: null,
            preview: null
        };
    }

    return {
        name: "Unknown Item",
        icon: null,
        type: "Item",
        tierUuid: null,
        preview: null
    };
}

function normalizeSingleOffer(offer, skinDatabase, apiMetadata, currencyDatabase) {
    const reward = offer.Rewards?.[0] || {};
    const item = resolveItemMetadata(reward.ItemID, skinDatabase, apiMetadata);
    const price = getOfferPrice(offer.Cost, currencyDatabase);
    const style = item.tierUuid ? getTierStyle(item.tierUuid) : { rarity: item.type, color: "#ff4655" };

    return {
        offerId: offer.OfferID,
        itemId: reward.ItemID || null,
        itemTypeId: reward.ItemTypeID || null,
        name: item.name,
        icon: item.icon,
        price,
        rarity: style.rarity,
        color: style.color,
        quantity: reward.Quantity || 1,
        itemType: item.type,
        preview: item.preview || null
    };
}

function buildBundleName(bundleMetadata, bundleItems) {
    if (bundleMetadata?.name) {
        return bundleMetadata.name;
    }

    const skinNames = bundleItems
        .filter((item) => item.itemType === "Skin")
        .map((item) => item.name)
        .filter(Boolean);

    const prefix = getCommonPrefix(skinNames);
    if (prefix && prefix.length >= 4) {
        return `${prefix} Bundle`;
    }

    return "Featured Bundle";
}

async function formatStorefront(storefront, skinDatabase, currencyDatabase) {
    const apiMetadata = await loadApiMetadata();
    const dailyOffers = (storefront?.SkinsPanelLayout?.SingleItemStoreOffers || []).map((offer) =>
        normalizeSingleOffer(offer, skinDatabase, apiMetadata, currencyDatabase)
    );
    const nightMarket = (storefront?.BonusStore?.BonusStoreOffers || []).map((entry) => {
        const offer = normalizeSingleOffer(entry.Offer, skinDatabase, apiMetadata, currencyDatabase);
        const discounted = getOfferPrice(entry.DiscountCosts, currencyDatabase);

        return {
            ...offer,
            originalPrice: offer.price,
            price: discounted,
            discountPercent: entry.DiscountPercent || 0
        };
    });
    const accessoryOffers = (storefront?.AccessoryStore?.AccessoryStoreOffers || []).map((entry) => {
        const offer = normalizeSingleOffer(entry.Offer, skinDatabase, apiMetadata, currencyDatabase);
        return {
            ...offer,
            contractId: entry.ContractID || null
        };
    });

    let featuredBundle = null;
    const bundle = storefront?.FeaturedBundle?.Bundle;
    if (bundle) {
        const bundleItems = (bundle.Items || []).map((entry) => {
            const item = resolveItemMetadata(entry.Item?.ItemID, skinDatabase, apiMetadata);
            const price = getOfferPrice({ [entry.CurrencyID]: entry.DiscountedPrice || entry.BasePrice || 0 }, currencyDatabase);

            return {
                itemId: entry.Item?.ItemID || null,
                itemTypeId: entry.Item?.ItemTypeID || null,
                name: item.name,
                icon: item.icon,
                itemType: item.type,
                quantity: entry.Item?.Amount || 1,
                price,
                isPromoItem: Boolean(entry.IsPromoItem)
            };
        });
        const bundleMetadata = apiMetadata.bundles.get(bundle.ID);

        featuredBundle = {
            id: bundle.ID,
            name: buildBundleName(bundleMetadata, bundleItems),
            icon: bundleMetadata?.icon || bundleItems.find((item) => item.icon)?.icon || null,
            remaining: formatDuration(storefront?.FeaturedBundle?.BundleRemainingDurationInSeconds),
            price: getOfferPrice(bundle.TotalDiscountedCost, currencyDatabase),
            originalPrice: getOfferPrice(bundle.TotalBaseCost, currencyDatabase),
            discountPercent: Math.round((bundle.TotalDiscountPercent || 0) * 100),
            items: bundleItems
        };
    }

    return {
        dailyOffers,
        nightMarket,
        featuredBundle,
        accessoryOffers,
        timers: {
            dailyOffers: formatDuration(storefront?.SkinsPanelLayout?.SingleItemOffersRemainingDurationInSeconds),
            nightMarket: formatDuration(storefront?.BonusStore?.BonusStoreRemainingDurationInSeconds),
            accessories: formatDuration(storefront?.AccessoryStore?.AccessoryStoreRemainingDurationInSeconds),
            dailyOffersSeconds: Number(storefront?.SkinsPanelLayout?.SingleItemOffersRemainingDurationInSeconds) || 0,
            nightMarketSeconds: Number(storefront?.BonusStore?.BonusStoreRemainingDurationInSeconds) || 0,
            accessoriesSeconds: Number(storefront?.AccessoryStore?.AccessoryStoreRemainingDurationInSeconds) || 0
        }
    };
}

app.disable("x-powered-by");
if (TRUST_PROXY) {
    app.set("trust proxy", true);
}
app.use(cors({
    origin(origin, callback) {
        if (!origin) {
            callback(null, true);
            return;
        }

        if (!ALLOWED_ORIGINS.length) {
            callback(null, true);
            return;
        }

        if (ALLOWED_ORIGINS.includes(origin)) {
            callback(null, true);
            return;
        }

        callback(new Error("Origin not allowed by CORS."));
    }
}));
app.use((req, res, next) => {
    res.setHeader(
        "Content-Security-Policy",
        [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' https: data: blob:",
            "media-src 'self' https: blob:",
            "font-src 'self' data:",
            "connect-src 'self' https://valorant-api.com",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'"
        ].join("; ")
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    if (req.secure || req.headers["x-forwarded-proto"] === "https") {
        res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
});
app.use(express.json({ limit: "16kb" }));
app.use(express.static(__dirname));
app.use((error, _req, res, next) => {
    if (!error) {
        next();
        return;
    }

    if (error.message === "Origin not allowed by CORS.") {
        setNoStore(res);
        res.status(403).json({
            ok: false,
            error: "This domain is not allowed to access the API."
        });
        return;
    }

    next(error);
});

async function createAuthenticatedClient() {
    const serializedCookie = String(process.env.VAL_COOKIE_JSON || "").trim();
    const ssidCookie = String(process.env.VAL_SSID || "").trim();
    let auth;

    if (serializedCookie) {
        console.log("Using serialized Riot cookie login...");

        let cookieData;
        try {
            cookieData = JSON.parse(serializedCookie);
        } catch (_error) {
            throw new Error("VAL_COOKIE_JSON is not valid JSON.");
        }

        const instance = new AuthInstance({ cookie: cookieData });
        auth = new Auth({ region: REGION, user: instance.toJSON() });

        if (!auth.isAuthenticated) {
            await auth.reauthorize();
        }
    } else {
        auth = new Auth({ region: REGION });
    }

    if (!serializedCookie && ssidCookie) {
        console.log("Using Riot browser session login...");
        auth.cookie.setCookieSync(
            `ssid=${ssidCookie}; Domain=riotgames.com; Path=/; Secure; HttpOnly`,
            "https://auth.riotgames.com"
        );
        const uriResponse = await auth.authorize();
        await auth.uriTokenization(uriResponse);
    } else if (!serializedCookie) {
        const username = process.env.VAL_USER;
        const password = process.env.VAL_PASS;

        if (!username || !password) {
            throw new Error(
                "Missing credentials. Set VAL_COOKIE_JSON, or VAL_SSID, or both VAL_USER and VAL_PASS in .env."
            );
        }

        console.log("Using Riot username/password login...");
        try {
            await auth.login({
                username,
                password
            });
        } catch (error) {
            const riotError = error.response?.data?.error;
            const country = error.response?.data?.country;

            if (riotError === "invalid_request" || error.message === "Request failed with status code 400") {
                throw new Error(
                    country
                        ? `Riot blocked username/password login for this session in ${country.toUpperCase()}. Use VAL_SSID from an already logged-in browser session.`
                        : "Riot blocked username/password login for this session. Use VAL_SSID from an already logged-in browser session."
                );
            }

            throw error;
        }

        if (auth.isMultifactor) {
            throw new Error(
                "This account requires MFA. Complete login with a VAL_SSID session instead."
            );
        }
    }

    return new WebClient({
        region: REGION,
        user: auth.toJSON()
    });
}

function readRiotLockfile() {
    if (!fs.existsSync(RIOT_LOCKFILE_PATH)) {
        throw new Error("Riot lockfile not found. Start Riot Client and VALORANT first.");
    }

    const [name, pid, port, password, protocol] = fs
        .readFileSync(RIOT_LOCKFILE_PATH, "utf8")
        .trim()
        .split(":");

    return { name, pid, port, password, protocol };
}

async function getLocalRiotSession() {
    const { port, password, protocol } = readRiotLockfile();
    const basicAuth = Buffer.from(`riot:${password}`).toString("base64");
    const httpsAgent = new https.Agent({ rejectUnauthorized: false });
    const client = axios.create({
        baseURL: `${protocol}://127.0.0.1:${port}`,
        httpsAgent,
        timeout: 10000,
        headers: {
            Authorization: `Basic ${basicAuth}`
        },
        validateStatus: () => true
    });

    const [tokenResponse, sessionsResponse] = await Promise.all([
        client.get("/entitlements/v1/token"),
        client.get("/product-session/v1/external-sessions")
    ]);

    if (tokenResponse.status !== 200) {
        throw new Error(`Local entitlements failed with ${tokenResponse.status}.`);
    }

    if (sessionsResponse.status !== 200) {
        throw new Error(`Local product session failed with ${sessionsResponse.status}.`);
    }

    const sessionEntry = Object.values(sessionsResponse.data || {})[0];
    const args = sessionEntry?.launchConfiguration?.arguments || [];
    const deploymentArg = args.find((arg) => arg.startsWith("-ares-deployment="));
    const deployment = deploymentArg ? deploymentArg.split("=")[1] : REGION;

    return {
        accessToken: tokenResponse.data.accessToken,
        entitlementsToken: tokenResponse.data.token,
        subject: tokenResponse.data.subject,
        region: deployment || REGION
    };
}

async function createClientFromCookieString(cookieString) {
    if (!cookieString || !String(cookieString).trim()) {
        throw new Error("Paste a Riot cookie string first.");
    }

    const auth = new Auth({ region: REGION });
    applyCookieString(auth, cookieString);

    const uriResponse = await auth.authorize();
    await auth.uriTokenization(uriResponse);

    return new WebClient({
        region: REGION,
        user: auth.toJSON()
    });
}

async function createClientFromRedirectUrl(redirectUrl) {
    if (!redirectUrl || !String(redirectUrl).trim()) {
        throw new Error("Paste the final Riot redirect URL first.");
    }

    const safeRedirectUrl = validateRiotRedirectUrl(redirectUrl);

    const tokens = parseRedirectTokens(safeRedirectUrl);
    const auth = new Auth({
        region: REGION,
        user: {
            cookie: authCookieJar(),
            isMultifactor: false,
            login_token: "",
            access_token: tokens.accessToken,
            id_token: tokens.idToken,
            session_state: tokens.sessionState,
            entitlements_token: ""
        }
    });

    auth.request.headers.setAuthorization(`Bearer ${tokens.accessToken}`);
    try {
        await auth.entitlementsTokenization();
    } catch (error) {
        throw new Error(`Entitlements request failed: ${getReadableError(error)}`);
    }

    let liveRegion;
    try {
        liveRegion = await auth.regionTokenization();
    } catch (error) {
        throw new Error(`Region lookup failed: ${getReadableError(error)}`);
    }

    return {
        preferredRegion: liveRegion || REGION,
        user: auth.toJSON(),
        subject: auth.subject,
        accessToken: tokens.accessToken,
        entitlementsToken: auth.entitlements_token
    };
}

async function getStorefrontWithFallback(request, subject, preferredRegion) {
    const regionsToTry = Array.from(
        new Set([preferredRegion, REGION, ...STORE_REGIONS].filter(Boolean))
    );
    let lastError;

    for (const region of regionsToTry) {
        try {
            const response = await request.get(
                `https://pd.${region}.a.pvp.net/store/v2/storefront/${subject}`
            );

            if (response.status < 200 || response.status >= 300) {
                const text = typeof response.data === "string"
                    ? response.data
                    : JSON.stringify(response.data);
                throw new Error(
                    `Region ${region} returned ${response.status}${text ? `: ${text.slice(0, 160)}` : ""}`
                );
            }

            return {
                storefront: { data: response.data },
                region
            };
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error("Storefront request failed for all tested regions.");
}

async function getStorefrontFromRemoteTokens(accessToken, entitlementsToken, subject, preferredRegion) {
    const clientVersion = "release-09.00-shipping-28-2628993";
    const clientPlatform = "eyJwbGF0Zm9ybVR5cGUiOiJQQyIsInBsYXRmb3JtT1MiOiJXaW5kb3dzIiwicGxhdGZvcm1PU1ZlcnNpb24iOiIxMC4wLjE5MDQzLjEuMjU2LjY0Yml0IiwicGxhdGZvcm1DaGlwc2V0IjoiVW5rbm93biJ9";
    const regionsToTry = Array.from(
        new Set([preferredRegion, REGION, ...STORE_REGIONS].filter(Boolean))
    );
    let lastError;

    for (const region of regionsToTry) {
        try {
            const { stdout } = await execFileAsync(CURL_BIN, [
                "-s",
                "-k",
                "-X",
                "POST",
                "-H",
                `Authorization: Bearer ${accessToken}`,
                "-H",
                `X-Riot-Entitlements-JWT: ${entitlementsToken}`,
                "-H",
                `X-Riot-ClientVersion: ${clientVersion}`,
                "-H",
                `X-Riot-ClientPlatform: ${clientPlatform}`,
                "-H",
                "Accept: application/json",
                "-H",
                "Content-Type: application/json",
                "-d",
                "{}",
                `https://pd.${region}.a.pvp.net/store/v3/storefront/${subject}`
            ], {
                windowsHide: true,
                timeout: 20000,
                maxBuffer: 10 * 1024 * 1024
            });

            let parsed;
            try {
                parsed = JSON.parse(stdout);
            } catch (_error) {
                throw new Error(`Region ${region} returned invalid JSON: ${stdout.slice(0, 200)}`);
            }

            if (parsed.httpStatus && parsed.errorCode) {
                throw new Error(`Region ${region} failed: ${parsed.errorCode} (${parsed.httpStatus}).`);
            }

            return {
                data: parsed,
                region
            };
        } catch (error) {
            lastError = error;
        }
    }

    throw lastError || new Error("Remote storefront failed for all tested regions.");
}

async function getStorefrontFromLocalClient() {
    const session = await getLocalRiotSession();
    const clientVersion = "release-09.00-shipping-28-2628993";
    const clientPlatform = "eyJwbGF0Zm9ybVR5cGUiOiJQQyIsInBsYXRmb3JtT1MiOiJXaW5kb3dzIiwicGxhdGZvcm1PU1ZlcnNpb24iOiIxMC4wLjE5MDQzLjEuMjU2LjY0Yml0IiwicGxhdGZvcm1DaGlwc2V0IjoiVW5rbm93biJ9";

    const { stdout } = await execFileAsync(CURL_BIN, [
        "-s",
        "-k",
        "-X",
        "POST",
        "-H",
        `Authorization: Bearer ${session.accessToken}`,
        "-H",
        `X-Riot-Entitlements-JWT: ${session.entitlementsToken}`,
        "-H",
        `X-Riot-ClientVersion: ${clientVersion}`,
        "-H",
        `X-Riot-ClientPlatform: ${clientPlatform}`,
        "-H",
        "Accept: application/json",
        "-H",
        "Content-Type: application/json",
        "-d",
        "{}",
        `https://pd.${session.region}.a.pvp.net/store/v3/storefront/${session.subject}`
    ], {
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 10 * 1024 * 1024
    });

    let parsed;
    try {
        parsed = JSON.parse(stdout);
    } catch (_error) {
        throw new Error(`Local storefront returned invalid JSON: ${stdout.slice(0, 200)}`);
    }

    if (parsed.httpStatus && parsed.errorCode) {
        throw new Error(`Local storefront failed: ${parsed.errorCode} (${parsed.httpStatus}).`);
    }

    return {
        data: parsed,
        region: session.region
    };
}

function authCookieJar() {
    return authEmptyCookieJar.serializeSync();
}

const authEmptyCookieJar = new Auth().cookie;

app.get("/health", (_req, res) => {
    setNoStore(res);
    res.json({ ok: true, region: REGION, browserAuthUrl: RIOT_BROWSER_AUTH_URL });
});

app.post("/test-cookie", createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_MAX_REQUESTS }), async (req, res) => {
    try {
        setNoStore(res);
        const skinDatabase = await loadSkinDatabase();
        const currencyDatabase = await loadCurrencyDatabase();
        const client = await createClientFromCookieString(req.body?.cookieString);
        const storefront = await client.Store.StoreFront.get(client.subject);

        res.json({
            ok: true,
            message: "Cookie worked.",
            offers: await formatStorefront(storefront.data, skinDatabase, currencyDatabase)
        });
    } catch (error) {
        console.error("Cookie test failed:", error);
        setNoStore(res);
        res.status(400).json({
            ok: false,
            error: getReadableError(error)
        });
    }
});

app.post("/test-redirect", createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_MAX_REQUESTS }), async (req, res) => {
    try {
        setNoStore(res);
        const skinDatabase = await loadSkinDatabase();
        const currencyDatabase = await loadCurrencyDatabase();
        const session = await createClientFromRedirectUrl(req.body?.redirectUrl);
        const result = await getStorefrontFromRemoteTokens(
            session.accessToken,
            session.entitlementsToken,
            session.subject,
            session.preferredRegion
        );

        res.json({
            ok: true,
            message: `Redirect URL worked on shard ${result.region}.`,
            offers: await formatStorefront(result.data, skinDatabase, currencyDatabase)
        });
    } catch (error) {
        console.error("Redirect test failed:", error);
        setNoStore(res);
        res.status(400).json({
            ok: false,
            error: getReadableError(error)
        });
    }
});

app.get("/get-real-store", createRateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS, maxRequests: RATE_LIMIT_MAX_REQUESTS }), async (_req, res) => {
    let localError = null;
    const hasEnvAuth =
        String(process.env.VAL_COOKIE_JSON || "").trim() ||
        String(process.env.VAL_SSID || "").trim() ||
        (String(process.env.VAL_USER || "").trim() && String(process.env.VAL_PASS || "").trim());

    try {
        setNoStore(res);
        const skinDatabase = await loadSkinDatabase();
        const currencyDatabase = await loadCurrencyDatabase();

        try {
            const storefront = await getStorefrontFromLocalClient();
            res.json(await formatStorefront(storefront.data, skinDatabase, currencyDatabase));
            return;
        } catch (error) {
            localError = error;
            console.warn("Local Riot Client path failed, falling back to env auth:", error.message);
        }

        if (!hasEnvAuth && localError) {
            throw new Error(`Local Riot Client auth failed: ${getReadableError(localError)}`);
        }

        const client = await createAuthenticatedClient();
        const storefront = await client.Store.StoreFront.get(client.subject);
        res.json(await formatStorefront(storefront.data, skinDatabase, currencyDatabase));
    } catch (error) {
        console.error("Store fetch failed:", error);
        setNoStore(res);
        const fallbackMessage = !hasEnvAuth && localError
            ? `Local Riot Client auth failed: ${getReadableError(localError)}`
            : !process.env.VAL_SSID && error.message === "Request failed with status code 400"
                ? "Riot blocked username/password login for this session. Use VAL_SSID from an already logged-in browser session."
                : getReadableError(error);

        res.status(500).json({
            error: fallbackMessage
        });
    }
});

app.use((_req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, HOST, () => {
    console.log(`ValStore server running at http://${HOST}:${PORT}`);
});
