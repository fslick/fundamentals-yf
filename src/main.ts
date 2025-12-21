import moment from "moment";
import YahooFinance from "yahoo-finance2";
import type { HistoricalHistoryResult } from "yahoo-finance2/modules/historical";
import type { QuoteSummaryResult } from "yahoo-finance2/modules/quoteSummary-iface";
import type { StatementPayload } from "./types";
import _ from "lodash";
import type { ChartResultArrayQuote } from "yahoo-finance2/modules/chart";

const equities = [
	// "SPY",
	// "QQQ",
	// "EUNL.DE",
	// "URTH",
	"NVDA",
	"AAPL",
	"MSFT",
	"AMZN",
	"GOOGL",
	"AVGO",
	"META",
	"NFLX",
	"ASML",
	"COST"
];
const cliSymbol = process.argv[2];
const symbol = (cliSymbol && cliSymbol.trim()) || equities[Math.floor(Math.random() * equities.length)]!;

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"] });

async function fetchPrices(symbol: string) {
	const chart = await yahooFinance.chart(symbol, {
		period1: moment().subtract(2, "years").format("YYYY-MM-DD"),
		period2: moment().toDate(),
	});
	return chart.quotes;
}

async function fetchQuarterlyStatements(symbol: string) {
	const response: unknown[] = await yahooFinance.fundamentalsTimeSeries(symbol, {
		period1: moment().subtract(2, "years").format("YYYY-MM-DD"),
		type: "quarterly",
		module: "all"
	}, { validateResult: false });
	return response.filter((item: any) => item.TYPE === "ALL") as StatementPayload[];
}

function calculateTrailingStatistics(allStatements: StatementPayload[], prices: ChartResultArrayQuote[]) {
	if (allStatements.length < 4) {
		return null;
	}

	const statements = _(allStatements).sortBy(s => moment(s.date).valueOf()).takeRight(4).value();
	const lastStatement = statements[statements.length - 1]!;
	const sharesOutstanding = lastStatement.ordinarySharesNumber!;
	const netIncome = _(statements).map(statement => statement.netIncome).sum();
	const freeCashFlow = _(statements).map(statement => statement.freeCashFlow).sum();
	const date = moment(lastStatement.date);
	const close = prices
		.filter(price => moment(price.date).isSame(date, "day") || moment(price.date).isBefore(date, "day"))
		.sort((a, b) => moment(b.date).diff(moment(a.date)))[0]?.close!;
	const marketCap = close * sharesOutstanding;
	return {
		date: date.toDate(),
		close: close,
		sharesOutstanding: sharesOutstanding,
		marketCap: marketCap,
		pe: marketCap / netIncome,
		fcfYield : freeCashFlow / marketCap
	};
}

function mapToRecord(quoteSummary: QuoteSummaryResult): unknown {
	const cashFlowData: any = null; // TODO awaits refactoring
	return {
		symbol: quoteSummary.price?.symbol,
		name: quoteSummary?.longName,
		marketCap: quoteSummary.price?.marketCap,
		currency: quoteSummary.price?.currency,
		marketPrice: quoteSummary.price?.regularMarketPrice,
		beta: quoteSummary.defaultKeyStatistics?.beta,
		trailingPE: quoteSummary.summaryDetail?.trailingPE,
		forwardPE: quoteSummary.summaryDetail?.forwardPE,
		nextEarningsDate: (() => {
			const earningsDateString = quoteSummary.calendarEvents?.earnings.earningsDate[0]?.toISOString().split("T")[0];
			const earningsDate = earningsDateString ? moment(earningsDateString) : undefined;
			return earningsDate && earningsDate > moment() ? earningsDateString : undefined;
		})(),
		fiftyTwoWeekRange: (() => {
			const price = quoteSummary.price?.regularMarketPrice!;
			const low = quoteSummary.summaryDetail?.fiftyTwoWeekLow!;
			const high = quoteSummary.summaryDetail?.fiftyTwoWeekHigh!;
			return (price - low) / (high - low);
		})(),
		freeCashFlowYield: (() => {
			const fcf = cashFlowData?.latest.freeCashFlow;
			const marketCap = quoteSummary.price?.marketCap;
			return fcf && marketCap ? (fcf / marketCap) : undefined;
		})(),
		sharesOutstanding: quoteSummary.defaultKeyStatistics?.sharesOutstanding,
		freeCashFlowPerShare: (() => {
			const fcf = cashFlowData?.latest.freeCashFlow;
			const sharesOutstanding = quoteSummary.defaultKeyStatistics?.sharesOutstanding;
			return fcf && sharesOutstanding ? fcf / sharesOutstanding : undefined;
		})(),
		revenueGrowthYoY: quoteSummary.financialData?.revenueGrowth,
		earningsGrowthYoY: quoteSummary.financialData?.earningsGrowth
	};
}

async function main() {
	const quoteSummary = await yahooFinance.quoteSummary(symbol,
		{
			modules:
				[
					"price",
					"summaryDetail",
					"defaultKeyStatistics",
					"financialData",
					"calendarEvents",
				]
		});
	console.log("QUOTE SUMMARY");
	console.log(JSON.stringify(quoteSummary, null, 4));
	console.log("\n");

	const quarterlyStatements = await fetchQuarterlyStatements(symbol);
	console.log("QUARTERLY STATEMENTS");
	console.log(JSON.stringify(quarterlyStatements, null, 4));
	console.log("\n");

	const prices = await fetchPrices(symbol);
	const trailing = calculateTrailingStatistics(quarterlyStatements, prices);
	console.log("TRAILING STATISTICS");
	console.log(JSON.stringify(trailing, null, 4));
	console.log("\n");

	const record = mapToRecord(quoteSummary);
	console.log("RESULT");
	console.log(JSON.stringify(record, null, 4));
}

main();
