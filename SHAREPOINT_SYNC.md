# Direct SharePoint sync (test setup)

This branch adds an optional direct sync from the CDAX Follow-up Bot to a SharePoint list. It does not change the follow-up engine's sending behavior. The list is created in the configured site if it does not exist, and case rows are upserted by CDAX incident ID.

## Before testing

1. In `sharepoint-sync.js`, replace `REPLACE_WITH_ENTRA_APPLICATION_CLIENT_ID` with the approved Entra application client ID. The tenant ID is already configured from the tenant ID supplied in the conversation.
2. In the Entra app registration, configure a **Single-page application** redirect URI equal to the value returned by `chrome.identity.getRedirectURL()` for the installed extension. For extension ID `kjagmmgjlhmeihbjcccbecmebbdgefdn`, it should be `https://kjagmmgjlhmeihbjcccbecmebbdgefdn.chromiumapp.org/`.
3. Configure delegated Microsoft Graph permission `Sites.ReadWrite.All` and obtain any consent required by the HP tenant. The extension has no client secret and does not store the Microsoft password.
4. Add `kjagmmgjlhmeihbjcccbecmebbdgefdn.chromiumapp.org` as a permitted SPA redirect URI. If the extension ID changes, update the redirect URI accordingly.
5. Load/reload this branch as an unpacked extension. Click the extension's context menu and choose **Connect / reconnect to SharePoint**. Sign in with the HP work account.

The extension uses authorization-code flow with PKCE. Access/refresh tokens, when issued, are kept only in `chrome.storage.session` and cleared at the end of the browser session. No tokens or credentials are written to the repository or `chrome.storage.local`.

## SharePoint list

Site: `https://hp.sharepoint.com/teams/cdax_followup_automation`
List: `CDAX Follow-up Cases`

The sync creates the list/columns as needed and updates rows by `incidentId`. It does not delete list rows. The list includes case number, customer, queue, owner, automation status, sent/planned follow-up counts, queue membership, response detected, last updated, and last action. Managers should be assigned SharePoint **View** permission by the site owner; this code does not change site or list permissions. A Members role may permit editing, so use a read-only group/permission level.

The extension must be running, signed in to CDAX, and online to refresh the list. Use the extension context menu's **Sync cases to SharePoint now** action for a manual sync. Automation storage changes also queue a background sync. If the access token expires and no refresh token was issued, reconnect from the same menu.

## Limitations

- This sync is an optional test scaffold and requires the actual Entra app registration and tenant consent. Placeholder client ID means sign-in will deliberately fail until configured.
- Graph permission availability/consent varies by tenant; `Sites.ReadWrite.All` is delegated and can require admin approval. Do not try to bypass tenant consent.
- Managers view the SharePoint List itself (or a SharePoint page embedding its list web part); this branch does not publish a separate hosted web app.
- This implementation is not production-validated against the HP tenant. Confirm list creation and field behavior in a test site/list before relying on it.
