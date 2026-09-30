# Consultant Scorecard: go-live steps

Standalone app. Same approach as the Store Visit app: Firebase free plan for sign-in and data, hosted on GitHub Pages or Firebase Hosting. No live connection to STORIS or ZapSight. You upload two files each week and the app does the rest.

Before you paste the Firebase config, the hosted link runs in **demo mode** with made-up people and a "View as" switch so you can see what each role sees. (Double-clicking index.html on your PC will not work; browsers block this kind of app from a local file. Put it on GitHub Pages first.)

## Files

| File | What it is |
|---|---|
| `index.html`, `app.js`, `core.js` | The app |
| `config.js` | The only file you edit: paste your Firebase config |
| `firestore.rules` | Who can see what. Paste into Firestore > Rules |
| `firebase.json` | Only needed if you host on Firebase Hosting |
| `test/` | Checks for the math and the access rules |

## One-time setup (about 20 minutes)

1. **Firebase project.** console.firebase.google.com > Add project > `1915-consultant-scorecard`. Skip Google Analytics.
2. **Web app config.** Project settings > Your apps > Web (`</>`) > register > copy the `firebaseConfig` block into `config.js`.
3. **Sign-in.** Build > Authentication > Get started > Sign-in method > turn on **Email/Password** (leave "Email link" off).
4. **Database.** Build > Firestore Database > Create database > Production mode > `us-east1`.
5. **Rules.** Firestore > Rules tab > replace everything with `firestore.rules` > Publish.
6. **Host it.** GitHub Pages (like the Smart Scheduler): new repo, upload all files, Settings > Pages > deploy from `main`. Then in Firebase Authentication > Settings > Authorized domains, add `yourname.github.io`.
7. **Sign in first as Frank** (fpina@1915south.com). Create account, click the verification email, Continue. You are the admin automatically.

## The weekly upload (Upload tab)

Drop both files together:

1. **RSA report**, the 1st of the month through the latest day. Keep the dates in the file name (`rsa_report_2026-09-01_to_2026-09-28.csv`); the app reads them. This builds every consultant card.
2. **Daily report** for the latest day (`daily-report-2026-09-28.csv`). The app uses the month-to-date column for each store's total, including Close Rate, Traffic, SPG with cancellations, and Protection Attachment. Region, Online and Total rows are skipped.

Check the preview, then Publish. Re-uploading a month replaces it.

**What the app leaves out of the RSA report:** RSA Goal, HOUSE SALES, EMPLOYEE DISCOUNT, zzz, conv, and anyone with $0 SPH (no sales hours: leaders, returns only).

## Consultants tab (team roster)

Load the **Store Sales Team Contacts** file (Paylocity export, "Sales Team" sheet: Location, Role, Name, Email). It sets everyone's store and title and, if you leave the box ticked, sets up their logins by work email. Reload it whenever people join, leave or transfer. Admin, exec and director logins are never changed by it.

- **RSA**: login shows only their own card, their 1:1 plan, the team plan, and their store total.
- **Assistant Selling Manager and Sales Lead**: they sell and they coach. Their login has two tabs: **Scorecards** (their whole store, where they run 1:1s with anyone but themselves, and the weekly team session) and **My scorecard** (their own card). Their own 1:1 is run by their leader.
- OPEN seats are skipped.

**Matching names in the RSA report to the roster.** Exact names match automatically (242 of 263 on the 9/28 files). The rest show on the Upload screen with a suggestion when there is one: a nickname (Danny / Daniel Mishler, Nathan / Nathaniel Pugh), a suffix (Daniel Martinez Jr), or a name change caught by work email (Jennifer Vallade is jvallade@, now Jennifer Cherry). Same-last-name matches (Suki / Son Keppel, Cody / William Valls) are filled in too, flagged "check it". Confirm once and the app remembers every link. For people who are not on the roster at all (left, or not in sales), tap "Leave off everyone with no match"; they are not asked about again, and you can bring anyone back on the Consultants tab.

## Logins tab

Roles: `admin` (everything), `exec` (every store, read only), `director` (their stores, or `*` for all; runs 1:1s and team sessions), `leader` (their store; with "Their own scorecard" set, also sees their own card), `consultant` (their own card only). Tick "Can upload files" for whoever owns the weekly upload. Each person opens the link, taps Create account with their work email, and verifies.

## What is on each card

**Consultant card (from the RSA report):** Net Sales, Sales / Hour, Avg Ticket, Eff. Margin, Finance %, Credit Apps, Bedding %, Bedding / Hour, Protection %, Protection / Hour, Delivery %, Cancellation %, Discount %. Bedding / Hour and Protection / Hour are SPH x the category percent, which is the same number as category sales / hours. Rank in the store and company-wide on every metric.

**Store total (from the daily report):** Net Sales, SPG with cancellations, Close Rate and Traffic against each store's budget; SPH, Avg Ticket, Eff. Margin, Finance %, Apps to Traffic, Bedding %, Bedding / Hour, Protection %, Protection / Hour, Protection Attach, Delivery %, Cancellation %.

Goals: Finance % 65, Credit Apps 18 a month, Protection % 8, Bedding / Hour $60, Protection / Hour $32, Protection Attach 60%, Cancellation 4% or less, Discount 12% or less. Change them on the Goals tab. Green is at or better than goal, amber within 20%, red beyond.

## Minimum standard

$250 rolling SPH ($150 at Outlet Regency, Outlet Pensacola, Outlet Greensboro). Rolling = last month's final sales and hours plus this month to date, so the window runs 30 to 61 days. The first month there is no "last month", so it is month to date only.

- Store view: a red box names anyone below; amber for anyone within 10% above. Rolling SPH column in the table.
- Consultant card: red banner with the number, dates and hours. The consultant sees it too.
- Weekly 1:1: Sales / Hour is locked in as focus #1, tagged Minimum standard.

## Weekly coaching

**1:1s.** Tap a consultant's name. Follow up on last week, pick no more than 2 focus areas (the app suggests them, with questions to ask and one thing to do this week), agree on the plan, save. The store table shows days since each person's last 1:1.

**Team sessions.** Under the store total. Same flow for the weekly team meeting or huddle, using the store's numbers from the daily report: the 2 drivers furthest from goal or budget (Close Rate, SPH, Finance, Bedding, Protection, Delivery, Cancellations and so on; Net Sales, SPG and Traffic are results, so they are not picked). Everyone in the store sees the team plan on their own card.

Every box has a Talk button for talk to text (Chrome, Edge, Safari).

## Security check before rollout

Rules require a verified email **and** a login record. Do this once:

1. Sign in as a test consultant. You should see only "My scorecard".
2. Sign in as a leader for one store. The store picker should list only that store.
3. Sign in as an Assistant Selling Manager. You should see your store plus My scorecard, and no 1:1 form on your own card.
4. Sign in with an email that has no login. You should see "not on the roster yet".
