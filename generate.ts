/**
 * Strava Wrapped - Generate yearly running stats and commit to GitHub
 *
 * This single-file script:
 * 1. Fetches all Run activities from Strava for a given year
 * 2. Computes summary statistics and highlights
 * 3. Generates a Markdown file
 * 4. Commits it to a GitHub repo using a GitHub App
 */

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

    // Handle token expiration
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

async function fetchAllRunsForYear(
    config: Config
): Promise<StravaActivity[]> {
    const year = config.year;
    const startOfYear = new Date(year, 0, 1).getTime() / 1000;
    const endOfYear = new Date(year + 1, 0, 1).getTime() / 1000;

    console.log(`📅 Fetching runs for ${year}...`);

    const allRuns: StravaActivity[] = [];
    let page = 1;
    const perPage = 200;

    while (true) {
        const activities = await stravaFetch<StravaActivity[]>(
            `/athlete/activities?after=${startOfYear}&before=${endOfYear}&page=${page}&per_page=${perPage}`,
            config
        );

        if (activities.length === 0) break;

        // Filter to only Run activities
        const runs = activities.filter(
            (a) => a.type === "Run" || a.sport_type === "Run"
        );
        allRuns.push(...runs);

        console.log(`  Page ${page}: ${activities.length} activities, ${runs.length} runs`);

        if (activities.length < perPage) break;
        page++;
    }

    console.log(`✅ Found ${allRuns.length} total runs for ${year}`);
    return allRuns;
}

// ============================================================================
// Stats Computation
// ============================================================================

interface Stats {
    year: number;
    totals: {
        runs: number;
        distanceMiles: number;
        movingTimeMinutes: number;
        elevationGainFeet: number;
        averagePaceMinPerMile: number;
    };
    highlights: {
        longestRun: { name: string; date: string; distanceMiles: number } | null;
        fastest5k: { name: string; date: string; paceMinPerMile: number } | null;
        fastestPace: { name: string; date: string; paceMinPerMile: number } | null;
    };
    consistency: {
        longestStreak: number;
        mostCommonWeekday: string;
        mostCommonHour: number;
    };
}

// Conversion helpers
const metersToMiles = (m: number) => m * 0.000621371;
const metersToFeet = (m: number) => m * 3.28084;
const secondsToMinutes = (s: number) => s / 60;

function formatPace(minPerMile: number): string {
    const mins = Math.floor(minPerMile);
    const secs = Math.round((minPerMile - mins) * 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function formatDuration(totalMinutes: number): string {
    const hours = Math.floor(totalMinutes / 60);
    const mins = Math.round(totalMinutes % 60);
    if (hours > 0) {
        return `${hours}h ${mins}m`;
    }
    return `${mins}m`;
}

function computeStats(runs: StravaActivity[], year: number): Stats {
    // Totals
    const totalDistance = runs.reduce((sum, r) => sum + r.distance, 0);
    const totalMovingTime = runs.reduce((sum, r) => sum + r.moving_time, 0);
    const totalElevation = runs.reduce((sum, r) => sum + r.total_elevation_gain, 0);

    const totalDistanceMiles = metersToMiles(totalDistance);
    const totalMovingTimeMinutes = secondsToMinutes(totalMovingTime);
    const averagePace =
        totalDistanceMiles > 0 ? totalMovingTimeMinutes / totalDistanceMiles : 0;

    // Longest run
    const longestRun = runs.reduce<StravaActivity | null>((longest, run) => {
        if (!longest || run.distance > longest.distance) return run;
        return longest;
    }, null);

    // Fastest 5k (runs that are at least 5k)
    const fiveKMeters = 5000;
    const runsOver5k = runs.filter((r) => r.distance >= fiveKMeters);
    const fastest5k = runsOver5k.reduce<StravaActivity | null>((fastest, run) => {
        // Calculate pace for just the 5k portion (approximation: use average pace)
        const paceSecPerMeter = run.moving_time / run.distance;
        const time5k = paceSecPerMeter * fiveKMeters;
        const currentFastestTime = fastest
            ? (fastest.moving_time / fastest.distance) * fiveKMeters
            : Infinity;
        if (time5k < currentFastestTime) return run;
        return fastest;
    }, null);

    // Fastest average pace (runs >= 3 miles)
    const threeMilesMeters = 3 * 1609.34;
    const runsOver3Miles = runs.filter((r) => r.distance >= threeMilesMeters);
    const fastestPace = runsOver3Miles.reduce<StravaActivity | null>(
        (fastest, run) => {
            const pace = run.moving_time / run.distance; // sec per meter
            const fastestPaceVal = fastest
                ? fastest.moving_time / fastest.distance
                : Infinity;
            if (pace < fastestPaceVal) return run;
            return fastest;
        },
        null
    );

    // Consistency: Longest daily streak
    const runDates = new Set(
        runs.map((r) => r.start_date_local.split("T")[0])
    );
    const sortedDates = Array.from(runDates).sort();
    let longestStreak = 0;
    let currentStreak = 0;
    let prevDate: Date | null = null;

    for (const dateStr of sortedDates) {
        const date = new Date(dateStr);
        if (prevDate) {
            const diff =
                (date.getTime() - prevDate.getTime()) / (1000 * 60 * 60 * 24);
            if (diff === 1) {
                currentStreak++;
            } else {
                currentStreak = 1;
            }
        } else {
            currentStreak = 1;
        }
        longestStreak = Math.max(longestStreak, currentStreak);
        prevDate = date;
    }

    // Most common weekday
    const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const weekdayCounts: Record<number, number> = {};
    for (const run of runs) {
        const day = new Date(run.start_date_local).getDay();
        weekdayCounts[day] = (weekdayCounts[day] || 0) + 1;
    }
    const mostCommonWeekdayNum = Object.entries(weekdayCounts).reduce(
        (max, [day, count]) =>
            count > (weekdayCounts[max] || 0) ? parseInt(day) : max,
        0
    );

    // Most common start hour
    const hourCounts: Record<number, number> = {};
    for (const run of runs) {
        const hour = new Date(run.start_date_local).getHours();
        hourCounts[hour] = (hourCounts[hour] || 0) + 1;
    }
    const mostCommonHour = Object.entries(hourCounts).reduce(
        (max, [hour, count]) =>
            count > (hourCounts[max] || 0) ? parseInt(hour) : max,
        0
    );

    // Build stats object
    const formatDate = (dateStr: string) => {
        const d = new Date(dateStr);
        return d.toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
        });
    };

    return {
        year,
        totals: {
            runs: runs.length,
            distanceMiles: Math.round(totalDistanceMiles * 10) / 10,
            movingTimeMinutes: Math.round(totalMovingTimeMinutes),
            elevationGainFeet: Math.round(metersToFeet(totalElevation)),
            averagePaceMinPerMile: averagePace,
        },
        highlights: {
            longestRun: longestRun
                ? {
                    name: longestRun.name,
                    date: formatDate(longestRun.start_date_local),
                    distanceMiles:
                        Math.round(metersToMiles(longestRun.distance) * 100) / 100,
                }
                : null,
            fastest5k: fastest5k
                ? {
                    name: fastest5k.name,
                    date: formatDate(fastest5k.start_date_local),
                    paceMinPerMile:
                        secondsToMinutes(fastest5k.moving_time) /
                        metersToMiles(fastest5k.distance),
                }
                : null,
            fastestPace: fastestPace
                ? {
                    name: fastestPace.name,
                    date: formatDate(fastestPace.start_date_local),
                    paceMinPerMile:
                        secondsToMinutes(fastestPace.moving_time) /
                        metersToMiles(fastestPace.distance),
                }
                : null,
        },
        consistency: {
            longestStreak,
            mostCommonWeekday: weekdays[mostCommonWeekdayNum],
            mostCommonHour,
        },
    };
}

// ============================================================================
// Markdown Generation
// ============================================================================

function generateMarkdown(stats: Stats): string {
    const lines: string[] = [];

    lines.push(`# 🏃 Strava Wrapped ${stats.year}`);
    lines.push("");
    lines.push(`Your running year in review.`);
    lines.push("");

    // Totals
    lines.push(`## 📊 Totals`);
    lines.push("");
    lines.push(`- **Total Runs:** ${stats.totals.runs}`);
    lines.push(`- **Total Distance:** ${stats.totals.distanceMiles.toLocaleString()} miles`);
    lines.push(`- **Total Time:** ${formatDuration(stats.totals.movingTimeMinutes)}`);
    lines.push(`- **Total Elevation Gain:** ${stats.totals.elevationGainFeet.toLocaleString()} feet`);
    lines.push(`- **Average Pace:** ${formatPace(stats.totals.averagePaceMinPerMile)} /mile`);
    lines.push("");

    // Highlights
    lines.push(`## 🏆 Highlights`);
    lines.push("");

    if (stats.highlights.longestRun) {
        const lr = stats.highlights.longestRun;
        lines.push(`### Longest Run`);
        lines.push(`- **${lr.name}** on ${lr.date}`);
        lines.push(`- Distance: ${lr.distanceMiles} miles`);
        lines.push("");
    }

    if (stats.highlights.fastest5k) {
        const f5k = stats.highlights.fastest5k;
        lines.push(`### Fastest 5K Pace`);
        lines.push(`- **${f5k.name}** on ${f5k.date}`);
        lines.push(`- Pace: ${formatPace(f5k.paceMinPerMile)} /mile`);
        lines.push("");
    }

    if (stats.highlights.fastestPace) {
        const fp = stats.highlights.fastestPace;
        lines.push(`### Fastest Average Pace (≥3 mi)`);
        lines.push(`- **${fp.name}** on ${fp.date}`);
        lines.push(`- Pace: ${formatPace(fp.paceMinPerMile)} /mile`);
        lines.push("");
    }

    // Consistency
    lines.push(`## 📅 Consistency`);
    lines.push("");
    lines.push(`- **Longest Streak:** ${stats.consistency.longestStreak} consecutive days`);
    lines.push(`- **Favorite Day:** ${stats.consistency.mostCommonWeekday}`);
    lines.push(`- **Favorite Time:** ${stats.consistency.mostCommonHour}:00`);
    lines.push("");

    // Footer
    lines.push(`---`);
    lines.push("");
    lines.push(`*Generated on ${new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })} with [Strava Wrapped](https://github.com/${process.env.GITHUB_OWNER}/${process.env.GITHUB_REPO})*`);

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
        iat: now - 60, // Issued 60 seconds ago (clock skew)
        exp: now + 600, // Expires in 10 minutes
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

    if (response.status === 404) {
        return null;
    }

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

    // Load configuration
    const config = loadConfig();
    console.log(`📆 Year: ${config.year}`);
    console.log(`📁 Target: ${config.github.owner}/${config.github.repo}`);
    console.log(`🧪 Dry Run: ${config.dryRun}\n`);

    // Initialize Strava token
    currentAccessToken = config.strava.accessToken;

    // Fetch runs
    const runs = await fetchAllRunsForYear(config);

    if (runs.length === 0) {
        console.log("⚠️  No runs found for this year. Exiting.");
        return;
    }

    // Compute stats
    console.log("\n📊 Computing stats...");
    const stats = computeStats(runs, config.year);

    // Generate Markdown
    console.log("📝 Generating Markdown...");
    const markdown = generateMarkdown(stats);
    const filePath = `wrapped/${config.year}.md`;

    // Dry run: print and exit
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

    // Get GitHub installation token
    const ghToken = await getInstallationToken(config);

    // Check if file exists
    console.log(`\n🔍 Checking for existing file: ${filePath}`);
    const existingFile = await getExistingFile(
        ghToken,
        config.github.owner,
        config.github.repo,
        filePath
    );

    // Check if content is identical
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

    // Commit file
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
