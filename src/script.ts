import _ from "lodash";
import pLimit from "p-limit";
import { fetchFromYahooFinance } from "./index";
import { parseCsv, saveToCsv } from "./lib/csv";
import { flattenObject, log } from "./lib/utils";

async function saveFlattenedResultsToCsv(results: Awaited<ReturnType<typeof fetchFromYahooFinance>>[], filepath: string) {
	const flattened = results.map(r => flattenObject(r));

	const symbolKeyValues = _(flattened)
		.flatMap(item => {
			return _.map(item, (value, key) => ({
				symbol: item.symbol as string,
				key,
				value
			}));
		})
		.filter(item => {
			const v = item.value;
			const withoutValue = v === null || v === undefined || v === "";
			const isEmptyObject = _.isPlainObject(v) && _.isEmpty(v);
			return !(withoutValue || isEmptyObject);
		})
		.sortBy(item => item.symbol)
		.value();

	// const symbolKeyValuesPath = "./output/symbolKeyValues.csv";
	await saveToCsv(symbolKeyValues, filepath);
	log(`File with key values available at ${filepath}`);
}

async function processAndSaveParallel(symbols: string[], filepath: string, parallelism = 2) {
	const limit = pLimit(parallelism);

	let counter = 0;
	const processSymbol = async (symbol: string) => {
		log(`${symbol} >> start`)
		const result = await fetchFromYahooFinance(symbol);
		counter++;
		log(`${symbol} >> done (${counter}/${symbols.length})`)
		return result
	}
	const results = await Promise.all(symbols.map(symbol => limit(() => processSymbol(symbol))));
	await saveFlattenedResultsToCsv(results, filepath);
	return results;
}

async function main() {
	const cliSymbol = process.argv[2];
	if (cliSymbol) {
		const result = await fetchFromYahooFinance(cliSymbol);
		console.log(JSON.stringify(result, null, 4));
		return;
	}

	const symbols = await parseCsv<{ symbol: string }>("./input/symbols.csv");
	const sampledSymbols = _(symbols)
		.sampleSize(symbols.length)
		.map(s => s.symbol)
		.value();

	await processAndSaveParallel(sampledSymbols, "./output/symbol-key-values.csv", 3);
	console.log("Done");
}

main();
