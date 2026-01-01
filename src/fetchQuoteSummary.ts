import { promises as fs } from "fs";
import { fetchSummaryWithAllModules } from "./api/api";
import { log } from "./utils";

const cliSymbol = process.argv[2]!;
if (!cliSymbol) {
    throw new Error("Symbol is required");
}

async function main() {
    log(cliSymbol);
    const quoteSummaryAll = await fetchSummaryWithAllModules(cliSymbol);
    await fs.mkdir("./output", { recursive: true });
    await fs.writeFile(`./output/${cliSymbol}-quoteSummaryAll.json`, JSON.stringify(quoteSummaryAll, null, 4));
    log("done");
}

main();
