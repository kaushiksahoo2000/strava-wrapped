# Strava Wrapped

Generate a yearly summary of all your Strava activities and commit it to GitHub using a GitHub App.

**Features:**

- Supports all activity types (Run, Ride, Swim, Hike, etc.)
- Computes stats per activity type
- Commits directly via GitHub App (no PATs)
- Safe to re-run (replaces existing file)

## Quick Start

```bash
# Preview without committing
make dry

# Generate and commit
make run
```

## Example Output

```markdown
# � Strava Wrapped 2025

> ✨ Your year in motion — 203 activities and counting!

## 📊 Year at a Glance

| Metric                | Value         |
| --------------------- | ------------- |
| 🔢 **Activities**     | 203           |
| 📏 **Distance**       | 1,245.8 miles |
| ⏱️ **Moving Time**    | 187h 42m      |
| ⛰️ **Elevation Gain** | 62,150 ft     |

## 🏅 By Activity Type

### 🏃 Run

| Stat       | Value      |
| ---------- | ---------- |
| Activities | 142        |
| Distance   | 856.2 mi   |
| Time       | 128h 15m   |
| Elevation  | 41,200 ft  |
| Avg Pace   | 8:59 /mile |

### 🚴 Ride

| Stat       | Value    |
| ---------- | -------- |
| Activities | 45       |
| Distance   | 382.4 mi |
| Time       | 52h 30m  |
| Avg Speed  | 14.6 mph |

## 🏆 Highlights

### 📏 Longest by Distance

> 🚴 **Century Ride**
>
> 102.3 miles • Ride • Aug 12, 2025

### ❤️ Favorite Activity

> 🏃 **Run**
>
> 142 times this year
```

## Setup

### 1. Create a GitHub App

1. Go to **[GitHub Settings → Developer settings → GitHub Apps](https://github.com/settings/apps)**
2. Click **New GitHub App**
3. Configure:
   - **Name:** `Strava Wrapped` (or anything)
   - **Homepage URL:** Any URL
   - **Webhook:** Uncheck "Active"
4. **Permissions:**
   - Repository permissions → **Contents: Read and write**
   - Leave everything else as "No access"
5. Click **Create GitHub App**
6. Note the **App ID** from the app page
7. Scroll down → **Generate a private key** → save as `private-key.pem`

### 2. Install the App

1. From your app page, click **Install App** (left sidebar)
2. Select your account
3. Choose **Only select repositories** → pick your target repo
4. Click **Install**
5. Get the **Installation ID** from the URL: `github.com/settings/installations/INSTALLATION_ID`

### 3. Create a Strava API App

1. Go to **[Strava API Settings](https://www.strava.com/settings/api)**
2. Create an application (any website/callback URL works)
3. Note your **Client ID** and **Client Secret**

### 4. Get Strava Tokens

Visit this URL (replace `YOUR_CLIENT_ID`):

```
https://www.strava.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost&scope=activity:read_all
```

After authorizing, you'll be redirected to `http://localhost?code=AUTHORIZATION_CODE`.

Exchange the code for tokens:

```bash
curl -X POST https://www.strava.com/oauth/token \
  -d client_id=YOUR_CLIENT_ID \
  -d client_secret=YOUR_CLIENT_SECRET \
  -d code=AUTHORIZATION_CODE \
  -d grant_type=authorization_code
```

Save the `access_token` and `refresh_token` from the response.

### 5. Configure Environment

```bash
cp .env.example .env
```

Fill in `.env`:

```env
YEAR=2025

STRAVA_ACCESS_TOKEN=xxx
STRAVA_REFRESH_TOKEN=xxx
STRAVA_CLIENT_ID=xxx
STRAVA_CLIENT_SECRET=xxx

GITHUB_APP_ID=123456
GITHUB_INSTALLATION_ID=12345678
GITHUB_PRIVATE_KEY_PATH=./private-key.pem

GITHUB_OWNER=your-username
GITHUB_REPO=strava-wrapped
```

### 6. Run

```bash
npm install tsx dotenv
make run
```

## Commands

| Command    | Description                           |
| ---------- | ------------------------------------- |
| `make run` | Generate and commit `wrapped/YEAR.md` |
| `make dry` | Preview output without committing     |
| `make fmt` | Format code with Prettier             |

## Re-running

The script is idempotent:

- Creates the file if it doesn't exist
- Replaces it if content changed
- Skips commit if content is identical

Run it anytime throughout the year to update your stats.

## Files

```
generate.ts      # Main script
Makefile         # Commands
.env             # Your credentials (not committed)
private-key.pem  # GitHub App key (not committed)
```

## Requirements

- Node.js 18+
- Strava account with activities
- GitHub App installed on target repo
