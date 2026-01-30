import { promises as fs } from "fs";
import { DateTime } from "luxon";
import YahooFinance from "yahoo-finance2";
import type { FundamentalsTimeSeriesAllResult } from "yahoo-finance2/modules/fundamentalsTimeSeries";
import type { AnnualStatement, QuarterlyStatement, TrailingStatement } from "./types";
import { log, memoize } from "../lib/utils";

const yahooFinance = new YahooFinance({ suppressNotices: ["yahooSurvey"], });

let yahooLogSuppressCount = 0;
let originalConsoleLog: typeof console.log | null = null;

async function withLibraryLoggingSuppressed<T>(fn: () => Promise<T>): Promise<T> {
	if (yahooLogSuppressCount === 0) {
		originalConsoleLog = console.log;
		console.log = (...args: any[]) => {
			if (args[0] === "Could not determine entry type:") {
				return;
			}
			originalConsoleLog!(...args);
		};
	}
	yahooLogSuppressCount += 1;
	try {
		return await fn();
	} finally {
		yahooLogSuppressCount -= 1;
		if (yahooLogSuppressCount === 0 && originalConsoleLog) {
			console.log = originalConsoleLog;
			originalConsoleLog = null;
		}
	}
}

function payloadDateToMoment(dateInput: Date | number) {
    return typeof dateInput === "number" ? DateTime.fromSeconds(dateInput) : DateTime.fromJSDate(dateInput);
}

async function saveJsonFile(symbol: string, type: string, data: any) {
    await fs.mkdir("./output/payloads", { recursive: true });
    await fs.writeFile(`./output/payloads/${symbol}-${type}.json`, JSON.stringify(data, null, 4));
}

const defaultPeriod1 = DateTime.now().minus({ years: 5, months: 1 });

const __fetchPrices = memoize(async (symbol: string) => withLibraryLoggingSuppressed(async () => {
    const chart = await yahooFinance.chart(symbol, {
        period1: defaultPeriod1.toFormat("yyyy-MM-dd"),
        period2: DateTime.now().toFormat("yyyy-MM-dd"),
    });
    return chart.quotes;
}));

const __fetchSummary = async (symbol: string) => {
    const quoteSummary = await withLibraryLoggingSuppressed(() => yahooFinance.quoteSummary(symbol,
        {
            modules:
                [
                    "defaultKeyStatistics",
                    "quoteType",
                    "earnings",
                    "price",
                    "earningsTrend",
                    "summaryDetail",
                    "financialData",
                ]
        }));
    await saveJsonFile(symbol, "quoteSummary", quoteSummary);
    return quoteSummary;
};

const __fetchSummaryWithAllModules = async (symbol: string) => {
    const quoteSummary = await withLibraryLoggingSuppressed(() => yahooFinance.quoteSummary(symbol,
        {
            modules:
                [
                    "assetProfile",
                    "calendarEvents",
                    "defaultKeyStatistics",
                    "earnings",
                    "earningsHistory",
                    "earningsTrend",
                    "financialData",
                    "fundOwnership",
                    "fundPerformance",
                    "fundProfile",
                    "indexTrend",
                    "industryTrend",
                    "insiderHolders",
                    "insiderTransactions",
                    "institutionOwnership",
                    "majorDirectHolders",
                    "majorHoldersBreakdown",
                    "netSharePurchaseActivity",
                    "price",
                    "quoteType",
                    "recommendationTrend",
                    "secFilings",
                    "sectorTrend",
                    "summaryDetail",
                    "summaryProfile",
                    "topHoldings",
                    "upgradeDowngradeHistory"
                ]
        }, { validateResult: false }));
    await saveJsonFile(symbol, "quoteSummaryAllModules", quoteSummary);
    return quoteSummary;
};

const __fetchQuarterlyStatements = async (symbol: string) => {
    const response: FundamentalsTimeSeriesAllResult[] = await withLibraryLoggingSuppressed(() => yahooFinance.fundamentalsTimeSeries(symbol, {
        period1: DateTime.now().minus({ years: 2 }).toFormat("yyyy-MM-dd"),
        type: "quarterly",
        module: "all"
    }, { validateResult: false }));
    await saveJsonFile(symbol, "quarterlyStatements", response);
    return response
        .filter(item => item.TYPE === "ALL")
        .map(item => ({ ...item, date: payloadDateToMoment(item.date) })) as QuarterlyStatement[];
};

const __fetchAnnualStatements = async (symbol: string) => {
    const response: FundamentalsTimeSeriesAllResult[] = await withLibraryLoggingSuppressed(() => yahooFinance.fundamentalsTimeSeries(symbol, {
        period1: DateTime.now().minus({ years: 5 }).toFormat("yyyy-MM-dd"),
        period2: DateTime.now().toFormat("yyyy-MM-dd"),
        type: "annual",
        module: "all"
    }, { validateResult: false }));
    await saveJsonFile(symbol, "annualStatements", response);
    return response
        .filter(item => item.TYPE === "ALL")
        .map(item => ({ ...item, date: payloadDateToMoment(item.date) })) as AnnualStatement[];
};

const __fetchTrailingStatement = async (symbol: string) => {
    const response: FundamentalsTimeSeriesAllResult[] = await withLibraryLoggingSuppressed(() => yahooFinance.fundamentalsTimeSeries(symbol, {
        period1: DateTime.now().minus({ years: 2 }).toFormat("yyyy-MM-dd"),
        type: "trailing",
        module: "all"
    }, { validateResult: false }));
    await saveJsonFile(symbol, "trailingStatement", response);
    return response
        .filter(item => item.TYPE === "ALL")
        .map(item => ({ ...item, date: payloadDateToMoment(item.date) })) as unknown as TrailingStatement[];
};

async function withRetries<T>(fn: () => Promise<T>, symbol: string, methodName: string, retries = 5, delay = 2000): Promise<T> {
    try {
        return await fn();
    } catch (error: any) {
        if (retries > 0 && (error?.code === 429 || error?.message?.includes("Too Many Requests"))) {
            log(`${symbol} >> ${methodName} >> Rate limited. Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
            return withRetries(fn, symbol, methodName, retries - 1, delay * 2);
        }
        throw error;
    }
}

export async function fetchPrices(symbol: string) {
    return withRetries(() => __fetchPrices(symbol), symbol, "fetchPrices");
}

export async function fetchSummary(symbol: string) {
    return withRetries(() => __fetchSummary(symbol), symbol, "fetchSummary");
}

export async function fetchSummaryWithAllModules(symbol: string) {
    return withRetries(() => __fetchSummaryWithAllModules(symbol), symbol, "fetchSummaryWithAllModules");
}

export async function fetchQuarterlyStatements(symbol: string) {
    return withRetries(() => __fetchQuarterlyStatements(symbol), symbol, "fetchQuarterlyStatements");
}

export async function fetchAnnualStatements(symbol: string) {
    return withRetries(() => __fetchAnnualStatements(symbol), symbol, "fetchAnnualStatements");
}

export async function fetchTrailingStats(symbol: string) {
    return withRetries(() => __fetchTrailingStatement(symbol), symbol, "fetchTrailingStats");
}
