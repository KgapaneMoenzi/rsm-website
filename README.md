# RSM Student Accommodation

Node.js (Express) site + application backend.

- `public/` the website (`index.html`, `admin.html`, `images/`)
- `server.js` API: student applications, admin login, ID photo viewing
- `lib/store.js` Neon Postgres storage (creates its own table on first start)

## Pages
- `/` public site with the application form
- `/admin` password-protected list of applications (view ID, WhatsApp, set status, delete)

## Environment variables (set these in Render)
| Name | What |
|------|------|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Neon connection string |
| `ADMIN_PASSWORD` | your admin password (10+ characters) |
| `SESSION_SECRET` | random 64-character string |

## Run on your own computer
```
npm install
npm start
```
With no `DATABASE_URL` it stores test data in a local `data/` folder and prints a temporary admin password in the terminal. Open http://localhost:3000.

## Updating the site later
Edit files, then `git add .`, `git commit -m "Update"`, `git push`. Render redeploys automatically.
