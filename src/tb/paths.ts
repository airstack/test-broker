import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** ci-broker's remote wrapper, uploaded to every box next to the repo's remote script */
export const WRAP_SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'core', 'wrap', 'cib-wrap.sh')
