/** `sharp` (native image processing, which `@livekit/agents` loads for LLM image inputs): no
 * voice or chat turn uses it, and any call throws, naming itself. */
import { unavailableModule } from "./unavailable.js";

export default unavailableModule("sharp").sharp;
