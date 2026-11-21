import describe from './describe.json' with { type: 'json' };
import { CodexWorld, worldId } from './world.js';

export default {
  id: worldId,
  label: '鳍鳍的 Codex',
  defaults: () => ({ enabled: false }),
  describe,
  create: (context) => new CodexWorld(context, describe.tools),
};
