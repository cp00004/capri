# Google Sign-In Setup

## 1. Create OAuth Consent Screen
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project (or create one: "Capri")
3. Go to **APIs & Services → OAuth consent screen**
4. User Type: **External** → Click "Create"
5. Fill in:
   - App name: **Capri**
   - User support email: your email
   - Developer contact: your email
6. Click "Save and Continue" through scopes (default is fine)
7. **Test users**: Add your Google email address here (required while in Testing mode)
8. Click "Save and Continue" → "Back to Dashboard"

## 2. Fix Branding (if you see "Your branding is not being shown to users")
1. Go to **APIs & Services → OAuth consent screen**
2. Click **Edit App** (pencil icon)
3. Fill in:
   - App name: **Capri**
   - User support email: your email
   - App logo: upload a 120x120px image (optional)
   - Application home page: `https://cp00004.github.io/capri/`
4. Click "Save and Continue" through all steps
5. To publish for all users: click **Publish App** → "Confirm"
   - Publishing should be instant for non-sensitive scopes (email/profile)

## 3. Create OAuth Client ID
1. Go to **APIs & Services → Credentials**
2. Click **+ CREATE CREDENTIALS → OAuth client ID**
3. Application type: **Web application**
4. Name: **Capri Web**
5. **Authorized JavaScript origins** — add ALL of these:
   - `http://localhost:4173`
   - `https://localhost:4174`
   - `https://cp00004.github.io`
   - Your hosted backend URL (if different)
6. **Authorized redirect URIs** — leave empty (GIS uses popup)
7. Click **Create**
8. Copy the **Client ID**

## 4. Configure the server
1. Open `.env` on your PC
2. Set: `GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com`
3. Set: `CAPRI_ALLOW_ORIGINS=https://cp00004.github.io`
4. Restart the server: `npm start`
5. Console should show: `google: sign-in ready`

## 5. Test
1. Open the app (http://localhost:4173 or https://cp00004.github.io/capri/)
2. Go to Settings → Account
3. Click "SIGN IN WITH GOOGLE"
4. Google popup appears → sign in
5. Your name/email shows in Settings

## Troubleshooting

### "Your branding is not being shown to users"
- Go to OAuth consent screen → Edit App → fill in app name, support email, home page
- Complete all steps and click "Save and Continue"
- Add yourself as a test user (Step 1, point 7)
- Click "Publish App" to make it available to all users

### Sign-in popup doesn't appear
- Check browser console (F12) for errors
- Make sure `https://cp00004.github.io` is in Authorized JavaScript origins
- Make sure the client ID in `.env` matches exactly
- Make sure `CAPRI_ALLOW_ORIGINS` includes the GitHub Pages origin
- Clear browser cache and try again

### "This app isn't verified" warning
- Normal for unpublished apps
- Click "Advanced" → "Go to Capri (unsafe)" to proceed
- To remove: publish the app (Step 2) and complete verification

### "Access blocked: This app's request is invalid"
- Client ID or origin is misconfigured
- Double-check client ID in `.env` matches Google Cloud Console
- Double-check authorized JavaScript origins include your app's origin

### "origin_not_allowed" error
- Add the origin to `CAPRI_ALLOW_ORIGINS` in `.env`
- Format: `CAPRI_ALLOW_ORIGINS=https://cp00004.github.io`
- Restart the server