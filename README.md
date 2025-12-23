# Strava Wrapped

Generate a yearly summary of your Strava running activities and commit it directly to a GitHub repository using a GitHub App.

## What It Does

This script:

1. Fetches all your Run activities from Strava for a given year
2. Computes summary statistics and personal highlights
3. Generates a clean Markdown file
4. Commits `wrapped/YEAR.md` to your GitHub repository

Everything runs locally. No servers, no webhooks, no GitHub Actions.

## Example Output

Here's what the generated `wrapped/2025.md` looks like:

```markdown
# 🏃 Strava Wrapped 2025

Your running year in review.

## 📊 Totals

- **Total Runs:** 156
- **Total Distance:** 892.4 miles
- **Total Time:** 142h 37m
- **Total Elevation Gain:** 48,250 feet
- **Average Pace:** 9:35 /mile

## 🏆 Highlights

### Longest Run

- **Morning Long Run** on Oct 15, 2025
- Distance: 18.62 miles

### Fastest 5K Pace

- **Tempo Tuesday** on Jun 3, 2025
- Pace: 7:12 /mile

### Fastest Average Pace (≥3 mi)

- **Race Day 10K** on Sep 8, 2025
- Pace: 6:58 /mile

## 📅 Consistency

- **Longest Streak:** 14 consecutive days
- **Favorite Day:** Saturday
- **Favorite Time:** 7:00

---

_Generated on December 23, 2025 with Strava Wrapped_
```

## Stats Included

**Totals**

- Total number of runs
- Total distance (miles)
- Total moving time
- Total elevation gain (feet)
- Average pace

**Highlights**

- Longest run of the year
- Fastest rolling 5K pace
- Fastest average pace (runs ≥ 3 miles)

**Consistency**

- Longest consecutive day streak
- Most common weekday for runs
- Most common start hour

## How GitHub Apps Work

This project uses a **GitHub App** instead of Personal Access Tokens (PATs). Here's why:

1. **Scoped permissions** — The app only gets `contents: write` access, nothing else
2. **Installation-based** — You install the app on specific repos, not your entire account
3. **No token management** — Tokens are generated on-demand and expire automatically
4. **Audit trail** — Commits show up as being from the app, not your personal account

The flow:

```
Private Key (PEM file)
    ↓
Generate JWT (signed with private key)
    ↓
Exchange JWT for Installation Token
    ↓
Use token to commit via GitHub API
```

## Setup

### 1. Clone this repository

```bash
git clone https://github.com/YOUR_USERNAME/strava-wrapped.git
cd strava-wrapped
```

### 2. Create a GitHub App

1. Go to [GitHub Developer Settings → GitHub Apps](https://github.com/settings/apps)
2. Click **New GitHub App**
3. Fill in:
   - **Name:** Something like "Strava Wrapped Committer"
   - **Homepage URL:** Your repo URL (or any URL)
   - **Webhook:** Uncheck "Active" (we don't need webhooks)
4. Set permissions:
   - **Repository permissions → Contents:** Read and write
   - All other permissions: No access
5. Click **Create GitHub App**
6. Note your **App ID** (shown on the app page)
7. Scroll down and click **Generate a private key**
   - Save the downloaded `.pem` file as `private-key.pem` in this directory

### 3. Install the GitHub App on your repository

1. From your app's settings page, click **Install App** in the sidebar
2. Choose your account
3. Select **Only select repositories** and pick the repo where you want commits
4. Click **Install**
5. Note the **Installation ID** from the URL: `https://github.com/settings/installations/INSTALLATION_ID`

### 4. Create a Strava API application

1. Go to [Strava API Settings](https://www.strava.com/settings/api)
2. Create an application (any website/callback URL works for local use)
3. Note your **Client ID** and **Client Secret**
4. Get your tokens by authorizing your app:

   Visit this URL (replace `YOUR_CLIENT_ID`):

   ```
   https://www.strava.com/oauth/authorize?client_id=YOUR_CLIENT_ID&response_type=code&redirect_uri=http://localhost&scope=activity:read_all
   ```

   After authorizing, you'll be redirected to `http://localhost?code=AUTHORIZATION_CODE`. Copy the code.

5. Exchange the code for tokens:

   ```bash
   curl -X POST https://www.strava.com/oauth/token \
     -d client_id=YOUR_CLIENT_ID \
     -d client_secret=YOUR_CLIENT_SECRET \
     -d code=AUTHORIZATION_CODE \
     -d grant_type=authorization_code
   ```

   Save the `access_token` and `refresh_token` from the response.

### 5. Create your `.env` file

```bash
cp .env.example .env
```

Fill in your values:

```env
YEAR=2025

# Strava
STRAVA_ACCESS_TOKEN=your_access_token
STRAVA_REFRESH_TOKEN=your_refresh_token
STRAVA_CLIENT_ID=your_client_id
STRAVA_CLIENT_SECRET=your_client_secret

# GitHub App
GITHUB_APP_ID=123456
GITHUB_INSTALLATION_ID=12345678
GITHUB_PRIVATE_KEY_PATH=./private-key.pem

# Target repo
GITHUB_OWNER=your_username
GITHUB_REPO=strava-wrapped

# Optional
DRY_RUN=false
```

### 6. Install dependencies and run

```bash
npm install tsx
make run
```

Or use dry run first to preview:

```bash
make dry
```

## Re-running

The script is **idempotent** — safe to run multiple times:

- If `wrapped/YEAR.md` doesn't exist, it creates it
- If it exists with different content, it replaces it
- If it exists with identical content, it skips the commit

This means you can re-run the script as often as you like (e.g., throughout the year) and it will always update to the latest stats without creating duplicate commits.

## Dry Run Mode

Set `DRY_RUN=true` to preview without committing:

```bash
make dry
```

This will:

- Fetch all your Strava data
- Compute all stats
- Generate the full Markdown
- Print it to the console
- Tell you whether the file would be created or updated
- **Not** commit anything to GitHub

## Make Commands

```bash
make run   # Generate and commit wrapped/YEAR.md
make dry   # Preview without committing
make fmt   # Format code with Prettier
```

## Requirements

- Node.js 18+ (for native fetch)
- A Strava account with running activities
- A GitHub App installed on your target repo

## Files

```
generate.ts     # The entire script (single file)
Makefile        # Make commands
README.md       # This file
private-key.pem # Your GitHub App private key (not committed)
.env            # Your environment variables (not committed)
```

## Security Notes

- Never commit your `private-key.pem` file
- Never commit your `.env` file
- Add both to `.gitignore`:

```gitignore
private-key.pem
.env
```

## License

MIT
