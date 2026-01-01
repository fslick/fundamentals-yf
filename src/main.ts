import _ from "lodash";
import moment from "moment";
import pLimit from "p-limit";
import type { ChartResultArrayQuote } from "yahoo-finance2/modules/chart";
import { fetchAnnualStatements, fetchPrices, fetchQuarterlyStatements, fetchSummary, fetchTrailingStats } from "./api/api";
import { parseCsv, saveToCsv } from "./csv";
import type { AnnualStatement, PeriodType, QuarterlyStatement, StatementPayload } from "./types";
import { log } from "./utils";

function priceOn(date: moment.Moment, prices: ChartResultArrayQuote[]) {
	const earliestPrice = _.minBy(prices, p => moment(p.date).valueOf());
	if (earliestPrice && date.isBefore(moment(earliestPrice.date), "day")) {
		throw new Error(`Requested date ${date.format("YYYY-MM-DD")} is before the earliest available price date ${moment(earliestPrice.date).format("YYYY-MM-DD")}`);
	}

	return prices
		.filter(price => moment(price.date).isSame(date, "day") || moment(price.date).isBefore(date, "day"))
		.sort((a, b) => moment(b.date).diff(moment(a.date)))[0]?.close!;
}

async function convertCurrencyInStatements<T extends StatementPayload<PeriodType>>(statements: T[], fromCurrency: string, toCurrency: string): Promise<T[]> {
	const pair = `${fromCurrency}${toCurrency}=X`;
	const rates = await fetchPrices(pair);

	const nonCurrencyFields = new Set([
		"date",
		"periodType",
		"TYPE",
		"basicAverageShares",
		"dilutedAverageShares",
		"ordinarySharesNumber",
		"shareIssued",
		"taxRateForCalcs"
	]);

	return statements.map(statement => {
		const rate = priceOn(statement.date, rates);
		const converted = { ...statement };

		for (const key of Object.keys(statement)) {
			const k = key as keyof T;
			const value = statement[k];
			if (typeof value === "number" && !nonCurrencyFields.has(key)) {
				(converted as any)[key] = value * rate;
			}
		}
		return converted;
	});
}

function calculateTrailingStatistics(allStatements: QuarterlyStatement[], prices: ChartResultArrayQuote[]) {
	if (allStatements.length < 4) {
		return null;
	}

	const statements = _(allStatements).sortBy(s => s.date.valueOf()).takeRight(4).value();
	const lastStatement = statements[statements.length - 1]!;
	const sharesOutstanding = lastStatement.basicAverageShares ?? lastStatement.ordinarySharesNumber;
	if (!sharesOutstanding) {
		throw new Error("Shares outstanding not found");
	}
	const netIncome = _(statements).map(statement => statement.netIncome).sum();
	const freeCashFlow = _(statements).map(statement => statement.freeCashFlow).sum();
	const eps = _(statements).sumBy(s => (s.netIncome && sharesOutstanding) ? s.netIncome / sharesOutstanding : 0);
	const date = lastStatement.date;
	const close = priceOn(date, prices);
	const marketCap = close * sharesOutstanding;
	return {
		date: date,
		close: close,
		sharesOutstanding: sharesOutstanding,
		marketCap: marketCap,
		netIncome: netIncome,
		freeCashFlow: freeCashFlow,
		eps: eps,
		pe: close / eps,
		fcfYield: freeCashFlow / marketCap,
		fcfPerShare: freeCashFlow / sharesOutstanding,
		totalCash: lastStatement.cashCashEquivalentsAndShortTermInvestments || lastStatement.cashAndCashEquivalents,
		totalDebt: lastStatement.totalDebt
	};
}

async function getTTMStatistics(
	symbol: string,
	prices: ChartResultArrayQuote[],
	priceCurrency?: string,
	statementCurrency?: string | null
) {
	const trailingStats = await fetchTrailingStats(symbol);
	let ttmStatements: StatementPayload<"TTM">[] = trailingStats;

	if (priceCurrency && statementCurrency && priceCurrency !== statementCurrency) {
		ttmStatements = await convertCurrencyInStatements(trailingStats, statementCurrency, priceCurrency);
	}

	if (ttmStatements.length === 0) {
		return null;
	}

	const statement = _(ttmStatements).sortBy(s => s.date.valueOf()).last()!;
	const close = priceOn(statement.date, prices);
	const sharesOutstanding = statement.basicAverageShares || statement.ordinarySharesNumber;

	if (!sharesOutstanding || !statement.netIncome || !statement.freeCashFlow) {
		return null;
	}

	return {
		date: statement.date,
		close: close,
		sharesOutstanding: sharesOutstanding,
		marketCap: close * sharesOutstanding,
		netIncome: statement.netIncome,
		freeCashFlow: statement.freeCashFlow,
		eps: statement.basicEPS!,
		pe: close / statement.basicEPS!,
		fcfYield: statement.freeCashFlow / (close * sharesOutstanding),
		fcfPerShare: statement.freeCashFlow / sharesOutstanding,
		totalCash: statement.cashCashEquivalentsAndShortTermInvestments || statement.cashAndCashEquivalents,
		totalDebt: statement.totalDebt
	};
}

function calculateGrowth(statementsInput: (QuarterlyStatement | AnnualStatement)[]) {
	if (statementsInput.length < 4) {
		return null;
	}

	const statements = _(statementsInput).sortBy(s => s.date.valueOf()).takeRight(4).value();
	const firstStatement = statements[0];
	const lastStatement = statements[statements.length - 1];

	if (!firstStatement || !lastStatement) {
		return null;
	}
	const intervals = statements.length - 1;

	const revenueGrowth = (() => {
		const start = firstStatement.totalRevenue;
		const end = lastStatement.totalRevenue;
		if (!start || !end || start <= 0 || end <= 0) {
			return null;
		}
		return Math.pow(end / start, 1 / intervals) - 1;
	})();

	const earningsGrowth = (() => {
		const start = firstStatement.netIncome;
		const end = lastStatement.netIncome;
		if (!start || !end || start <= 0 || end <= 0) {
			return null;
		}
		// Note: CAGR is problematic if start value is negative. 
		// For simplicity and typical financial reporting, we return null if start earnings are non-positive.
		return Math.pow(end / start, 1 / intervals) - 1;
	})();

	return {
		revenue: revenueGrowth,
		earnings: earningsGrowth
	};
}

async function processSymbol(symbol: string) {
	log(`${symbol} >> Start`);

	const quoteSummary = await fetchSummary(symbol);
	const quoteType = quoteSummary.price!.quoteType;
	const priceCurrency = quoteSummary.price!.currency;
	const statementCurrency = quoteSummary.financialData?.financialCurrency;

	const prices = await fetchPrices(symbol);
	let annualStatements = quoteType === "EQUITY" ? await fetchAnnualStatements(symbol) : [];
	let quarterlyStatements = quoteType === "EQUITY" ? await fetchQuarterlyStatements(symbol) : [];

	if (priceCurrency && statementCurrency && priceCurrency !== statementCurrency) {
		annualStatements = await convertCurrencyInStatements(annualStatements, statementCurrency!, priceCurrency!);
		quarterlyStatements = await convertCurrencyInStatements(quarterlyStatements, statementCurrency!, priceCurrency!);
	}

	let thisPeriod = quoteType === "EQUITY" ? calculateTrailingStatistics(quarterlyStatements, prices) : null;
	if (!thisPeriod && quoteType === "EQUITY") {
		thisPeriod = await getTTMStatistics(symbol, prices, priceCurrency, statementCurrency);
	}

	const previousPeriod = (() => {
		const previousQuarterStatements = _(quarterlyStatements)
			.sortBy(s => s.date.valueOf())
			.dropRight(1)
			.takeRight(4)
			.value();

		if (quoteType !== "EQUITY" || previousQuarterStatements.length < 4) {
			return null;
		}
		return calculateTrailingStatistics(previousQuarterStatements, prices);
	})();

	const annualGrowth = calculateGrowth(annualStatements);
	const quarterlyGrowth = calculateGrowth(quarterlyStatements);

	const price = quoteSummary.price!.regularMarketPrice ?? prices[prices.length - 1]!.close!;
	const sharesOutstanding = quoteSummary.defaultKeyStatistics?.sharesOutstanding ?? thisPeriod?.sharesOutstanding;
	const marketCap = sharesOutstanding ? price * sharesOutstanding : undefined;
	const growthEstimate = (period: string) => {
		const trend = quoteSummary.earningsTrend?.trend.find(t => t.period === period);
		if (!trend) {
			return null;
		}

		const estimate = {
			endDate: trend.endDate,
			earningsGrowth: trend.earningsEstimate.growth,
			revenueGrowth: trend.revenueEstimate.growth,
			earningsAnalysts: trend.earningsEstimate.numberOfAnalysts,
			revenueAnalysts: trend.revenueEstimate.numberOfAnalysts
		};
		return estimate;
	};
	return {
		symbol,
		info: {
			name: quoteSummary.price!.longName,
			quoteType: quoteType,
			currency: priceCurrency,
			statementCurrency: statementCurrency,
			earningsDate: quoteSummary.earnings?.earningsChart?.earningsDate[0],
			listingDate: quoteSummary.quoteType!.firstTradeDateEpochUtc
		},
		keyStatistics: {
			price: price,
			sharesOutstanding: quoteSummary.defaultKeyStatistics?.sharesOutstanding,
			marketCap: quoteType === "EQUITY" ? marketCap : undefined,
			beta: quoteSummary.defaultKeyStatistics?.beta,
			fiftyTwoWeekRange: (() => {
				const low = quoteSummary.summaryDetail?.fiftyTwoWeekLow!;
				const high = quoteSummary.summaryDetail?.fiftyTwoWeekHigh!;
				return (price - low) / (high - low);
			})(),
		},
		valuation: {
			calcultedTrailingPE: thisPeriod?.netIncome && sharesOutstanding ? (sharesOutstanding * price) / thisPeriod.netIncome : quoteSummary.summaryDetail!.trailingPE,
			trailingPE: quoteSummary.summaryDetail!.trailingPE,
			forwardPE: quoteSummary.summaryDetail!.forwardPE,
			fcfYield: thisPeriod?.freeCashFlow && marketCap ? thisPeriod.freeCashFlow / marketCap : null,
			fcfPerShare: thisPeriod?.freeCashFlow && sharesOutstanding ? thisPeriod.freeCashFlow / sharesOutstanding : null,
			trailingEPS: quoteSummary.defaultKeyStatistics!.trailingEps,
			forwardEPS: quoteSummary.defaultKeyStatistics!.forwardEps,
			priceToSales: quoteSummary.summaryDetail!.priceToSalesTrailing12Months,
		},
		thisPeriod,
		previousPeriod,
		growth: {
			earningsAnnualGrowth: quoteSummary.financialData?.earningsGrowth,
			quarterlyEarningsGrowth: quoteSummary.defaultKeyStatistics?.earningsQuarterlyGrowth,
			quarterlyRevenueGrowth: quoteSummary.financialData?.revenueGrowth,
			revenue: {
				annual: annualGrowth?.revenue,
				quarterly: quarterlyGrowth?.revenue
			},
			earnings: {
				annual: annualGrowth?.earnings,
				quarterly: quarterlyGrowth?.earnings
			}
		},
		growthEstimates: {
			thisQuarter: growthEstimate("0q"),
			nextQuarter: growthEstimate("+1q"),
			thisYear: growthEstimate("0y"),
			nextYear: growthEstimate("+1y")
		}
	};
}

function flattenObject(obj: any, prefix = ""): any {
	return Object.keys(obj).reduce((acc: any, k: string) => {
		const pre = prefix.length ? prefix + "." : "";
		if (typeof obj[k] === "object" && obj[k] !== null && !Array.isArray(obj[k]) && !(obj[k] instanceof Date) && !moment.isMoment(obj[k])) {
			Object.assign(acc, flattenObject(obj[k], pre + k));
		} else {
			acc[pre + k] = obj[k];
		}
		return acc;
	}, {});
}

async function saveResultsToCsv(results: Awaited<ReturnType<typeof processSymbol>>[], path: string) {
	const flattened = results.map(r => flattenObject(r));
	await saveToCsv(flattened, path);

	const symbolKeyValues = _(flattened)
		.flatMap(item => {
			return _.map(item, (value, key) => ({
				symbol: item.symbol as string,
				key,
				value
			}));
		})
		.value();
	await saveToCsv(symbolKeyValues, "./output/symbolKeyValues.csv");
}

async function processAndSave(symbols: string[]) {
	const results: Awaited<ReturnType<typeof processSymbol>>[] = [];
	for (const symbol of symbols) {
		results.push(await processSymbol(symbol));
	}
	await saveResultsToCsv(results, "./output/report.csv");
	return results;
}

async function processAndSaveParallel(symbols: string[], parallelism = 2) {
	const limit = pLimit(parallelism);
	const results = await Promise.all(symbols.map(symbol => limit(() => processSymbol(symbol))));
	await saveResultsToCsv(results, "./output/report.csv");
	return results;
}

async function main() {
	const cliSymbol = process.argv[2];
	if (cliSymbol) {
		const result = await processSymbol(cliSymbol);
		console.log(JSON.stringify(result, null, 4));
		return;
	}

	const symbols = await parseCsv<{ symbol: string }>("./input/symbols.csv");
	const sampledSymbols = _(symbols)
		.sampleSize(100)
		.map(s => s.symbol)
		.value();

	await processAndSaveParallel(sampledSymbols, 2);
	console.log("Done");
}

main();
