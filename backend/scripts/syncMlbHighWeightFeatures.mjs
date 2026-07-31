/**
 * 同步高權重特徵：venueName + PIT 先發身份進 historical feature rows。
 */
import {
  backfillVenueNameOnFeatureRows,
  getHighWeightFeatureCoverage,
  labelLegacyOracleStarterIdentity,
  syncPitProbableIntoFeatureRows,
} from '../src/services/MlbHighWeightFeatureSync.js';
import { backfillMlbProbableStarterSnapshotsFromTruth } from '../src/services/MlbProbableStarterService.js';

const truthBackfill = backfillMlbProbableStarterSnapshotsFromTruth();
const venue = backfillVenueNameOnFeatureRows();
const oracle = labelLegacyOracleStarterIdentity();
const pit = await syncPitProbableIntoFeatureRows();

console.log(JSON.stringify({
  truthBackfill,
  venue,
  oracle,
  pit: {
    targets: pit.targets,
    updated: pit.updated,
    skipped: pit.skipped,
    missingFeatureRow: pit.missingFeatureRow,
    failed: pit.failed,
  },
  coverage: getHighWeightFeatureCoverage(),
}, null, 2));
