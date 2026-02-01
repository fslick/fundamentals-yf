import _ from "lodash";
import { DateTime } from "luxon";
import type { ChartResultArrayQuote } from "yahoo-finance2/modules/chart";
import { fetchAnnualStatements, fetchPrices, fetchQuarterlyStatements, fetchSummary, fetchTrailingStats } from "./api/api";
import type { AnnualStatement, PeriodType, QuarterlyStatement, StatementPayload } from "./api/types";

function priceOn(date: DateTime, prices: ChartResultArrayQuote[]) {
    const earliestPrice = _.minBy(prices, p => p.date);
    const earliestPriceDate = earliestPrice ? DateTime.fromJSDate(earliestPrice.date) : null;

    if (earliestPriceDate && date.startOf("day") < earliestPriceDate.startOf("day")) {
        throw new Error(`Requested date ${date.toFormat("yyyy-MM-dd")} is before the earliest available price date ${earliestPriceDate.toFormat("yyyy-MM-dd")}`);
    }

    return prices
        .filter(price => {
            const pDate = DateTime.fromJSDate(price.date);
            return pDate.hasSame(date, "day") || pDate.startOf("day") < date.startOf("day");
        })
        .sort((a, b) => b.date.getTime() - a.date.getTime())[0]?.close!;
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

interface StatisticsInput {
    date: DateTime;
    close: number;
    sharesOutstanding: number;
    dilutedSharesOutstanding: number;
    netIncome: number;
    freeCashFlow: number;
    stockBasedCompensation: number;
    eps: number;
    totalCash: number | undefined;
    totalDebt: number | undefined;
    totalRevenue: number | undefined;
    operatingIncome: number | undefined;
}

function calculateValuationMetrics(input: StatisticsInput) {
    const {
        close, sharesOutstanding, dilutedSharesOutstanding, netIncome, freeCashFlow,
        stockBasedCompensation, eps, date, totalCash, totalDebt, totalRevenue, operatingIncome
    } = input;

    const marketCap = close * sharesOutstanding;
    const dilutedMarketCap = close * dilutedSharesOutstanding;

    return {
        date,
        close,
        sharesOutstanding,
        dilutedSharesOutstanding,
        marketCap,
        dilutedMarketCap,
        netIncome,
        freeCashFlow,
        stockBasedCompensation,
        eps,
        pe: eps ? close / eps : null,
        fcfYield: freeCashFlow ? freeCashFlow / marketCap : null,
        fcfYieldAdjusted: (freeCashFlow && stockBasedCompensation)
            ? (freeCashFlow - stockBasedCompensation) / dilutedMarketCap
            : null,
        fcfPerShare: freeCashFlow ? freeCashFlow / sharesOutstanding : null,
        fcfPerShareAdjusted: (freeCashFlow && stockBasedCompensation)
            ? (freeCashFlow - stockBasedCompensation) / dilutedSharesOutstanding
            : null,
        totalCash,
        totalDebt,
        totalRevenue,
        operatingIncome
    };
}

function calculateTrailingStatistics(allStatements: QuarterlyStatement[], prices: ChartResultArrayQuote[]) {
    if (allStatements.length < 4) {
        return null;
    }

    const statements = _(allStatements).sortBy(s => s.date).takeRight(4).value();
    const lastStatement = statements[statements.length - 1]!;
    const sharesOutstanding = lastStatement.basicAverageShares ?? lastStatement.ordinarySharesNumber;
    if (!sharesOutstanding) {
        throw new Error("Shares outstanding not found");
    }
    const netIncome = _(statements).map(statement => statement.netIncome).sum();
    const freeCashFlow = _(statements).map(statement => statement.freeCashFlow).sum();
    const stockBasedCompensation = _(statements).map(statement => statement.stockBasedCompensation).sum();
    const totalRevenue = _(statements).map(statement => statement.totalRevenue).sum();
    const operatingIncome = _(statements).map(statement => statement.operatingIncome).sum();
    const eps = _(statements).sumBy(s => (s.netIncome && sharesOutstanding) ? s.netIncome / sharesOutstanding : 0);
    const date = lastStatement.date;
    const close = priceOn(date, prices);

    return calculateValuationMetrics({
        date,
        close,
        sharesOutstanding,
        dilutedSharesOutstanding: lastStatement.dilutedAverageShares || sharesOutstanding,
        netIncome,
        freeCashFlow,
        stockBasedCompensation,
        eps,
        totalCash: lastStatement.cashCashEquivalentsAndShortTermInvestments || lastStatement.cashAndCashEquivalents,
        totalDebt: lastStatement.totalDebt,
        totalRevenue,
        operatingIncome
    });
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

    const statement = _(ttmStatements).sortBy(s => s.date).last()!;
    const close = priceOn(statement.date, prices);
    const sharesOutstanding = statement.basicAverageShares || statement.ordinarySharesNumber;

    if (!sharesOutstanding || !statement.netIncome || !statement.freeCashFlow) {
        return null;
    }

    return calculateValuationMetrics({
        date: statement.date,
        close,
        sharesOutstanding,
        dilutedSharesOutstanding: statement.dilutedAverageShares || sharesOutstanding,
        netIncome: statement.netIncome,
        freeCashFlow: statement.freeCashFlow,
        stockBasedCompensation: statement.stockBasedCompensation || 0,
        eps: statement.basicEPS!,
        totalCash: statement.cashCashEquivalentsAndShortTermInvestments || statement.cashAndCashEquivalents,
        totalDebt: statement.totalDebt,
        totalRevenue: statement.totalRevenue,
        operatingIncome: statement.operatingIncome
    });
}

function calculateGrowth(statementsInput: (QuarterlyStatement | AnnualStatement)[]) {
    if (statementsInput.length < 4) {
        return null;
    }

    const statements = _(statementsInput).sortBy(s => s.date).takeRight(4).value();
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

export async function fetchFromYahooFinance(symbol: string) {
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
            .sortBy(s => s.date)
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
            trailingPE: quoteSummary.summaryDetail!.trailingPE,
            forwardPE: quoteSummary.summaryDetail!.forwardPE,
            fcfYield: thisPeriod?.freeCashFlow && marketCap ? thisPeriod.freeCashFlow / marketCap : null,
            fcfYieldAdjusted: thisPeriod?.fcfYieldAdjusted ?? null,
            fcfPerShare: thisPeriod?.freeCashFlow && sharesOutstanding ? thisPeriod.freeCashFlow / sharesOutstanding : null,
            fcfPerShareAdjusted: thisPeriod?.fcfPerShareAdjusted ?? null,
            trailingEPS: quoteSummary.defaultKeyStatistics!.trailingEps,
            forwardEPS: quoteSummary.defaultKeyStatistics!.forwardEps
        },
        thisPeriod,
        previousPeriod,
        marginsAndGrowth: {
            operatingMargin: thisPeriod?.operatingIncome && thisPeriod?.totalRevenue ? thisPeriod.operatingIncome / thisPeriod.totalRevenue : null,
            profitMargin: thisPeriod?.netIncome && thisPeriod?.totalRevenue ? thisPeriod.netIncome / thisPeriod.totalRevenue : null,
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
