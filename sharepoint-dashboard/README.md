# CDAX Follow-up Bot: SharePoint manager dashboard

This folder contains a SharePoint Framework (SPFx) client-side web part for a **read-only manager view** of the `CDAX Follow-up Cases` list. It displays the six requested summary filters—All Cases, In Queue, Follow-ups in Progress, Customer Responded, New Chat / Call, Ready for Closure—and a searchable case table. It refreshes every minute and includes a manual refresh button. It has no case action controls.

## Data fields expected in the SharePoint list

`Title`, `incidentId`, `customer`, `queueName`, `owner`, `automationStatus`, `followupsSent`, `followupsPlanned`, `inQueue`, `responseDetected`, `newContactDetected`, `lastUpdated`, `lastAction`.

`newContactDetected` should be true for cases with a detected new chat or call. If your sync implementation does not create/populate that column, add it; otherwise that card will show zero.

## Build and deployment

This is SPFx source, not a prebuilt `.sppkg`. Use the SharePoint Framework toolchain version compatible with SPFx 1.20 and Node 18.17.1, then run `npm install` and `gulp bundle --ship` / `gulp package-solution --ship` after adding the standard SPFx generator configuration files. Uploading and deploying the resulting package to the tenant App Catalog requires an authorized SharePoint admin/App Catalog owner. Add the web part to a modern SharePoint page on `https://hp.sharepoint.com/teams/cdax_followup_automation`, configure the list name if needed, and grant managers View permission to the list/site.

This source scaffold is not compiled or tenant-validated in this environment. Because the repo does not contain the SPFx generator configuration or tenant App Catalog access, it is not yet a deployable package. The current extension sync remains separate; use the approved sync to populate the list.
