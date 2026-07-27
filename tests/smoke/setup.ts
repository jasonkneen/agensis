import { installDomShims } from './harness';

// Installed once per test file, before any module under test is imported, so a
// component that touches ResizeObserver / matchMedia / fetch during its first
// render finds them already there.
installDomShims();
