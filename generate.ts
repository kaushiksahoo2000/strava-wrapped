/**
 * Strava Wrapped - Generate yearly activity stats and commit to GitHub
 *
 * This single-file script:
 * 1. Fetches all activities from Strava for a given year
 * 2. Computes summary statistics by activity type
 * 3. Generates a Markdown file
 * 4. Commits it to a GitHub repo using a GitHub App
 */

import "dotenv/config";
import * as fs from "fs";
import * as crypto from "crypto";

// ============================================================================
// Configuration
// ============================================================================

interface Config {
    year: number;
    strava: {
        accessToken: string;
        refreshToken: string;
        clientId: string;
        clientSecret: string;
    };
    github: {
        appId: string;
        installationId: string;
        privateKeyPath: string;
        owner: string;
        repo: string;
    };
    dryRun: boolean;
}

function loadConfig(): Config {
    const required = (name: string): string => {
        const value = process.env[name];
        if (!value) {
            throw new Error(`Missing required environment variable: ${name}`);
        }
        return value;
    };

    return {
        year: parseInt(process.env.YEAR || new Date().getFullYear().toString(), 10),
        strava: {
            accessToken: required("STRAVA_ACCESS_TOKEN"),
            refreshToken: required("STRAVA_REFRESH_TOKEN"),
            clientId: required("STRAVA_CLIENT_ID"),
            clientSecret: required("STRAVA_CLIENT_SECRET"),
        },
        github: {
            appId: required("GITHUB_APP_ID"),
            installationId: required("GITHUB_INSTALLATION_ID"),
            privateKeyPath: process.env.GITHUB_PRIVATE_KEY_PATH || "./private-key.pem",
            owner: required("GITHUB_OWNER"),
            repo: required("GITHUB_REPO"),
        },
        dryRun: process.env.DRY_RUN === "true",
    };
}

// ============================================================================
// Strava Types
// ============================================================================

interface StravaActivity {
    id: number;
    name: string;
    type: string;
    sport_type: string;
    start_date: string;
    start_date_local: string;
    distance: number; // meters
    moving_time: number; // seconds
    elapsed_time: number; // seconds
    total_elevation_gain: number; // meters
    average_speed: number; // meters per second
    max_speed: number; // meters per second
}

interface StravaTokenResponse {
    access_token: string;
    refresh_token: string;
    expires_at: number;
}

// ============================================================================
// Strava API
// ============================================================================

let currentAccessToken: string;

async function refreshStravaToken(config: Config): Promise<string> {
    console.log("🔄 Refreshing Strava access token...");

    const response = await fetch("https://www.strava.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            client_id: config.strava.clientId,
            client_secret: config.strava.clientSecret,
            refresh_token: config.strava.refreshToken,
            grant_type: "refresh_token",
        }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to refresh token: ${response.status} ${text}`);
    }

    const data: StravaTokenResponse = await response.json();
    console.log("✅ Token refreshed successfully");
    return data.access_token;
}

async function stravaFetch<T>(
    endpoint: string,
    config: Config,
    retried = false
): Promise<T> {
    const url = `https://www.strava.com/api/v3${endpoint}`;
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${currentAccessToken}` },
    });

    if (response.status === 401 && !retried) {
        currentAccessToken = await refreshStravaToken(config);
        return stravaFetch(endpoint, config, true);
    }

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Strava API error: ${response.status} ${text}`);
    }

    return response.json();
}

async function fetchAllActivitiesForYear(config: Config): Promise<StravaActivity[]> {
    const year = config.year;
    const startOfYear = new Date(year, 0, 1).getTime() / 1000;
    const endOfYear = new Date(year + 1, 0, 1).getTime() / 1000;

    console.log(`📅 Fetching activities for ${year}...`);

    const allActivities: StravaActivity[] = [];
    let page = 1;
    const perPage = 200;

    while (true) {
        const activities = await stravaFetch<StravaActivity[]>(
            `/athlete/activities?after=${startOfYear}&before=${endOfYear}&page=${page}&per_page=${perPage}`,
            config
        );

        if (activities.length === 0) break;

        // Filter out activities with no moving time
        const valid = activities.filter((a) => a.moving_time > 0);
        allActivities.push(...valid);

        console.log(`  Page ${page}: ${activities.length} activities (${valid.length} valid)`);

        if (activities.length < perPage) break;
        page++;
    }

    console.log(`✅ Found ${allActivities.length} total activities for ${year}`);
    return allActivities;
}

// ============================================================================
// Stats Computation
// ============================================================================

interface ActivityTypeStats {
    type: string;
    count: number;
    distanceMiles: number;
    movingTimeMinutes: number;
    elevationGainFeet: number;
}

interface Stats {
    year: number;
    overall: {
        totalActivities: number;
        distanceMiles: number;
        movingTimeMinutes: number;
        elevationGainFeet: number;
    };
    byType: ActivityTypeStats[];
    highlights: {
        longestByDistance: { name: string; type: string; date: string; distanceMiles: number } | null;
        longestByTime: { name: string; type: string; date: string; durationMinutes: number } | null;
        busiestDay: { date: string; count: number } | null;
        mostCommonType: { type: string; count: number } | null;
    };
}

// Conversion helpers
const metersToMiles = (m: number) => m * 0.000621371;
const metersToFeet = (m: number) => m * 3.28084;
const secondsToMinutes = (s: number) => s / 60;

function formatDuration(totalMinutes: number): string {
    const hours = Math.floor(totalMinutes / 60);
    const mins = Math.round(totalMinutes % 60);
    if (hours > 0) {
        return `${hours}h ${mins}m`;
    }
    return `${mins}m`;
}

function formatPace(minPerMile: number): string {
    const mins = Math.floor(minPerMile);
    const secs = Math.round((minPerMile - mins) * 60);
    return `${mins}:${secs.toString().padStart(2, "0")} /mile`;
}

function formatSpeed(mph: number): string {
    return `${mph.toFixed(1)} mph`;
}

function formatDate(dateStr: string): string {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
    });
}

function computeStats(activities: StravaActivity[], year: number): Stats {
    // Overall totals
    const totalDistance = activities.reduce((sum, a) => sum + a.distance, 0);
    const totalMovingTime = activities.reduce((sum, a) => sum + a.moving_time, 0);
    const totalElevation = activities.reduce((sum, a) => sum + a.total_elevation_gain, 0);

    // Group by type
    const byTypeMap: Record<string, StravaActivity[]> = {};
    for (const activity of activities) {
        const type = activity.type;
        if (!byTypeMap[type]) byTypeMap[type] = [];
        byTypeMap[type].push(activity);
    }

    // Compute per-type stats
    const byType: ActivityTypeStats[] = Object.entries(byTypeMap)
        .map(([type, acts]) => ({
            type,
            count: acts.length,
            distanceMiles: Math.round(metersToMiles(acts.reduce((s, a) => s + a.distance, 0)) * 10) / 10,
            movingTimeMinutes: Math.round(secondsToMinutes(acts.reduce((s, a) => s + a.moving_time, 0))),
            elevationGainFeet: Math.round(metersToFeet(acts.reduce((s, a) => s + a.total_elevation_gain, 0))),
        }))
        .sort((a, b) => b.count - a.count); // Sort by count descending

    // Highlights: longest by distance
    const longestByDistance = activities.reduce<StravaActivity | null>((longest, act) => {
        if (!longest || act.distance > longest.distance) return act;
        return longest;
    }, null);

    // Highlights: longest by time
    const longestByTime = activities.reduce<StravaActivity | null>((longest, act) => {
        if (!longest || act.moving_time > longest.moving_time) return act;
        return longest;
    }, null);

    // Highlights: busiest day
    const dayCount: Record<string, number> = {};
    for (const act of activities) {
        const day = act.start_date_local.split("T")[0];
        dayCount[day] = (dayCount[day] || 0) + 1;
    }
    const busiestDayEntry = Object.entries(dayCount).reduce<[string, number] | null>(
        (max, entry) => (!max || entry[1] > max[1] ? entry : max),
        null
    );

    // Highlights: most common type
    const mostCommonType = byType.length > 0 ? byType[0] : null;

    return {
        year,
        overall: {
            totalActivities: activities.length,
            distanceMiles: Math.round(metersToMiles(totalDistance) * 10) / 10,
            movingTimeMinutes: Math.round(secondsToMinutes(totalMovingTime)),
            elevationGainFeet: Math.round(metersToFeet(totalElevation)),
        },
        byType,
        highlights: {
            longestByDistance: longestByDistance
                ? {
                    name: longestByDistance.name,
                    type: longestByDistance.type,
                    date: formatDate(longestByDistance.start_date_local),
                    distanceMiles: Math.round(metersToMiles(longestByDistance.distance) * 100) / 100,
                }
                : null,
            longestByTime: longestByTime
                ? {
                    name: longestByTime.name,
                    type: longestByTime.type,
                    date: formatDate(longestByTime.start_date_local),
                    durationMinutes: Math.round(secondsToMinutes(longestByTime.moving_time)),
                }
                : null,
            busiestDay: busiestDayEntry
                ? { date: formatDate(busiestDayEntry[0]), count: busiestDayEntry[1] }
                : null,
            mostCommonType: mostCommonType
                ? { type: mostCommonType.type, count: mostCommonType.count }
                : null,
        },
    };
}

// ============================================================================
// Markdown Generation
// ============================================================================

// Emoji mapping for activity types
const activityEmoji: Record<string, string> = {
    Run: "🏃",
    Ride: "🚴",
    Swim: "🏊",
    Walk: "🚶",
    Hike: "🥾",
    WeightTraining: "🏋️",
    Workout: "💪",
    Yoga: "🧘",
    CrossFit: "🏋️",
    Elliptical: "🔄",
    StairStepper: "🪜",
    Rowing: "🚣",
    Kayaking: "🛶",
    Canoeing: "🛶",
    Surfing: "🏄",
    Skateboard: "🛹",
    InlineSkate: "🛼",
    IceSkate: "⛸️",
    Snowboard: "🏂",
    AlpineSki: "⛷️",
    NordicSki: "🎿",
    Golf: "⛳",
    Soccer: "⚽",
    Tennis: "🎾",
    Pickleball: "🏓",
    Badminton: "🏸",
    RockClimbing: "🧗",
    VirtualRide: "🖥️🚴",
    VirtualRun: "🖥️🏃",
    EBikeRide: "🔋🚴",
    Handcycle: "🦽",
    Wheelchair: "🦽",
};

function getActivityEmoji(type: string): string {
    return activityEmoji[type] || "🏅";
}

function generateMarkdown(stats: Stats): string {
    const lines: string[] = [];

    lines.push(`# 🎉 Strava Wrapped ${stats.year}`);
    lines.push("");
    lines.push(`> ✨ Your year in motion — ${stats.overall.totalActivities} activities and counting!`);
    lines.push("");

    // Overall
    lines.push(`## 📊 Year at a Glance`);
    lines.push("");
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| 🔢 **Activities** | ${stats.overall.totalActivities} |`);
    lines.push(`| 📏 **Distance** | ${stats.overall.distanceMiles.toLocaleString()} miles |`);
    lines.push(`| ⏱️ **Moving Time** | ${formatDuration(stats.overall.movingTimeMinutes)} |`);
    lines.push(`| ⛰️ **Elevation Gain** | ${stats.overall.elevationGainFeet.toLocaleString()} ft |`);
    lines.push("");

    // By Activity Type
    lines.push(`## 🏅 By Activity Type`);
    lines.push("");

    for (const typeStats of stats.byType) {
        const emoji = getActivityEmoji(typeStats.type);
        lines.push(`### ${emoji} ${typeStats.type}`);
        lines.push("");
        lines.push(`| Stat | Value |`);
        lines.push(`|------|-------|`);
        lines.push(`| Activities | ${typeStats.count} |`);
        if (typeStats.distanceMiles > 0) {
            lines.push(`| Distance | ${typeStats.distanceMiles.toLocaleString()} mi |`);
        }
        lines.push(`| Time | ${formatDuration(typeStats.movingTimeMinutes)} |`);
        if (typeStats.elevationGainFeet > 0) {
            lines.push(`| Elevation | ${typeStats.elevationGainFeet.toLocaleString()} ft |`);
        }
        // Average pace/speed for distance-based activities
        if (typeStats.distanceMiles > 0 && typeStats.movingTimeMinutes > 0) {
            const avgPace = typeStats.movingTimeMinutes / typeStats.distanceMiles;
            const avgSpeed = typeStats.distanceMiles / (typeStats.movingTimeMinutes / 60);
            if (typeStats.type === "Run" || typeStats.type === "Walk" || typeStats.type === "Hike") {
                lines.push(`| Avg Pace | ${formatPace(avgPace)} |`);
            } else {
                lines.push(`| Avg Speed | ${formatSpeed(avgSpeed)} |`);
            }
        }
        lines.push("");
    }

    // Highlights
    lines.push(`## 🏆 Highlights`);
    lines.push("");

    if (stats.highlights.longestByDistance) {
        const h = stats.highlights.longestByDistance;
        const emoji = getActivityEmoji(h.type);
        lines.push(`### 📏 Longest by Distance`);
        lines.push(`> ${emoji} **${h.name}**`);
        lines.push(`>`);
        lines.push(`> ${h.distanceMiles} miles • ${h.type} • ${h.date}`);
        lines.push("");
    }

    if (stats.highlights.longestByTime) {
        const h = stats.highlights.longestByTime;
        const emoji = getActivityEmoji(h.type);
        lines.push(`### ⏱️ Longest by Time`);
        lines.push(`> ${emoji} **${h.name}**`);
        lines.push(`>`);
        lines.push(`> ${formatDuration(h.durationMinutes)} • ${h.type} • ${h.date}`);
        lines.push("");
    }

    if (stats.highlights.busiestDay) {
        const h = stats.highlights.busiestDay;
        lines.push(`### 📅 Busiest Day`);
        lines.push(`> 🔥 **${h.date}**`);
        lines.push(`>`);
        lines.push(`> ${h.count} activities in one day!`);
        lines.push("");
    }

    if (stats.highlights.mostCommonType) {
        const h = stats.highlights.mostCommonType;
        const emoji = getActivityEmoji(h.type);
        lines.push(`### ❤️ Favorite Activity`);
        lines.push(`> ${emoji} **${h.type}**`);
        lines.push(`>`);
        lines.push(`> ${h.count} times this year`);
        lines.push("");
    }

    // Footer
    lines.push(`---`);
    lines.push("");
    lines.push(`<p align="center">`);
    lines.push(`  <em>Generated on ${new Date().toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
    })} • Powered by Strava</em>`);
    lines.push(`</p>`);

    return lines.join("\n");
}

// ============================================================================
// GitHub App Authentication
// ============================================================================

function base64url(buffer: Buffer): string {
    return buffer
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");
}

function createJWT(appId: string, privateKey: string): string {
    const now = Math.floor(Date.now() / 1000);

    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
        iat: now - 60,
        exp: now + 600,
        iss: appId,
    };

    const encodedHeader = base64url(Buffer.from(JSON.stringify(header)));
    const encodedPayload = base64url(Buffer.from(JSON.stringify(payload)));
    const message = `${encodedHeader}.${encodedPayload}`;

    const signature = crypto.sign("RSA-SHA256", Buffer.from(message), privateKey);
    const encodedSignature = base64url(signature);

    return `${message}.${encodedSignature}`;
}

async function getInstallationToken(config: Config): Promise<string> {
    console.log("🔐 Getting GitHub App installation token...");

    const privateKey = fs.readFileSync(config.github.privateKeyPath, "utf-8");
    const jwt = createJWT(config.github.appId, privateKey);

    const response = await fetch(
        `https://api.github.com/app/installations/${config.github.installationId}/access_tokens`,
        {
            method: "POST",
            headers: {
                Authorization: `Bearer ${jwt}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to get installation token: ${response.status} ${text}`);
    }

    const data = await response.json();
    console.log("✅ Installation token obtained");
    return data.token;
}

// ============================================================================
// GitHub Contents API
// ============================================================================

interface GitHubFileResponse {
    sha: string;
    content: string;
}

async function getExistingFile(
    token: string,
    owner: string,
    repo: string,
    path: string
): Promise<GitHubFileResponse | null> {
    const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        {
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        }
    );

    if (response.status === 404) return null;

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to get file: ${response.status} ${text}`);
    }

    return response.json();
}

async function upsertFile(
    token: string,
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    existingSha: string | null
): Promise<void> {
    const body: Record<string, string> = {
        message,
        content: Buffer.from(content).toString("base64"),
    };

    if (existingSha) {
        body.sha = existingSha;
    }

    const response = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/contents/${path}`,
        {
            method: "PUT",
            headers: {
                Authorization: `Bearer ${token}`,
                Accept: "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28",
                "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
        }
    );

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to upsert file: ${response.status} ${text}`);
    }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    console.log("🚀 Strava Wrapped Generator\n");

    const config = loadConfig();
    console.log(`📆 Year: ${config.year}`);
    console.log(`📁 Target: ${config.github.owner}/${config.github.repo}`);
    console.log(`🧪 Dry Run: ${config.dryRun}\n`);

    currentAccessToken = config.strava.accessToken;

    const activities = await fetchAllActivitiesForYear(config);

    if (activities.length === 0) {
        console.log("⚠️  No activities found for this year. Exiting.");
        return;
    }

    console.log("\n📊 Computing stats...");
    const stats = computeStats(activities, config.year);

    console.log("📝 Generating Markdown...");
    const markdown = generateMarkdown(stats);
    const filePath = `wrapped/${config.year}.md`;

    if (config.dryRun) {
        console.log("\n" + "=".repeat(60));
        console.log("DRY RUN - Generated Markdown:");
        console.log("=".repeat(60) + "\n");
        console.log(markdown);
        console.log("\n" + "=".repeat(60));
        console.log(`File would be written to: ${filePath}`);
        console.log("=".repeat(60));
        return;
    }

    const ghToken = await getInstallationToken(config);

    console.log(`\n🔍 Checking for existing file: ${filePath}`);
    const existingFile = await getExistingFile(
        ghToken,
        config.github.owner,
        config.github.repo,
        filePath
    );

    if (existingFile) {
        const existingContent = Buffer.from(existingFile.content, "base64").toString("utf-8");
        if (existingContent === markdown) {
            console.log("✅ File already exists with identical content. Skipping commit.");
            return;
        }
        console.log("📄 File exists, will update (sha: " + existingFile.sha.slice(0, 7) + ")");
    } else {
        console.log("📄 File does not exist, will create");
    }

    const commitMessage = `🏃 Add Strava Wrapped ${config.year}`;
    console.log(`\n📤 Committing: ${commitMessage}`);

    await upsertFile(
        ghToken,
        config.github.owner,
        config.github.repo,
        filePath,
        markdown,
        commitMessage,
        existingFile?.sha || null
    );

    console.log(`\n✅ Done! Check ${config.github.owner}/${config.github.repo}/${filePath}`);
}

main().catch((err) => {
    console.error("❌ Error:", err.message);
    process.exit(1);
});
