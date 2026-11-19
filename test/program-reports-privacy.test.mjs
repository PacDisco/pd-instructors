import assert from "node:assert/strict";
import { isPrivateType, isOwnReport } from "../netlify/functions/get-program-reports.js";

// Private types
for (const t of ["Self Evaluation", "Instructor Self-Evaluation", "Self Assessment",
                 "Co-Instructor Feedback", "Co Instructor Evaluation", "co-instructor review"]) {
  assert.equal(isPrivateType(t), true, t);
}
// Shared types
for (const t of ["Weekly Update", "Incident Report", "Accommodation Review", "Hazard Report", "", null]) {
  assert.equal(isPrivateType(t), false, String(t));
}

const me = { email: "Jane@PD.org", firstname: "Jane", lastname: "Doe" };
// Email wins when present
assert.equal(isOwnReport({ instructorEmail: "jane@pd.org", submitter: "Someone Else" }, me), true);
assert.equal(isOwnReport({ instructorEmail: "bob@pd.org", submitter: "Jane Doe" }, me), false);
// Name fallback for old submissions
assert.equal(isOwnReport({ instructorEmail: "", submitter: "jane  doe" }, me), true);
assert.equal(isOwnReport({ instructorEmail: "", submitter: "Bob Smith" }, me), false);
// Nothing to match on -> hidden
assert.equal(isOwnReport({ instructorEmail: "", submitter: "" }, me), false);
assert.equal(isOwnReport({ instructorEmail: "", submitter: "Jane Doe" }, { email: "x@y.z" }), false);

console.log("program-reports-privacy: all passed");
