import { reviewProject, type ProjectTrustRecords } from "./pi-trust";

/**
 * Test-only: a records store that says every project is trusted as it is now. A stored "trusted" only counts while the
 * project's pi files are what was reviewed, so this returns the current review as the stored one. Never import it from app code.
 */
export const trustEveryProject: ProjectTrustRecords = {
  getProjectTrust: () => "trusted",
  setProjectTrust: () => {},
  getProjectReview: (cwd) => reviewProject(cwd).record,
};
