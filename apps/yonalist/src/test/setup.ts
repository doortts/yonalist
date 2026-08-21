import "@testing-library/jest-dom/vitest";
import { configure } from "@testing-library/dom";

// Every findBy/waitFor in the suite rides this one budget, and it is wall clock:
// the 1000 ms default fails whichever test happens to be mid-wait when a
// co-running workload starves its fork. A ceiling, not a sleep -- a passing wait
// still returns on the next poll.
// The dom package, not react: same config singleton, but importing the react one
// here would load react-dom into all 90 files when only 38 render anything.
configure({ asyncUtilTimeout: 10_000 });
