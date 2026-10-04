import { parentPort, workerData } from "node:worker_threads";
import { extractBinary } from "./attachment-parser.js";
parentPort!.postMessage(
  await extractBinary(Buffer.from(workerData.bytes), workerData.name),
);
