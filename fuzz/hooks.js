// Custom hooks loaded via jazzer --customHooks. Enables the strong mode of the
// prototype-pollution bug detector (assignment + variable-declaration
// instrumentation), which the default weak mode does not cover.
import { getBugDetectorConfiguration } from "@jazzer.js/bug-detectors";

getBugDetectorConfiguration("prototype-pollution")?.instrumentAssignmentsAndVariableDeclarations();
