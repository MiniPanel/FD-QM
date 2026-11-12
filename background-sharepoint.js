// MV3 service-worker entry point. Keep the existing automation engine unchanged.
import './background.js';
import { initSharePointSync } from './sharepoint-sync.js';

initSharePointSync();
