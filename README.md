# fundamentals-yf

`fundamentals-yf` is a TypeScript-based tool designed to fetch, analyze, and export financial fundamental data for stock symbols using the Yahoo Finance API. It calculates key metrics like Trailing Twelve Months (TTM) statistics, growth rates, and valuation ratios, and exports the data to CSV for further analysis.

## Features

- **Data Fetching**: Retrieves summary, price history, annual statements, and quarterly statements from Yahoo Finance.
- **Financial Analysis**:
  - Calculates **TTM (Trailing Twelve Months)** statistics including Net Income, Free Cash Flow, EPS, PE Ratio, and FCF Yield.
  - Computes **Growth Rates** for Revenue and Earnings (Year-over-Year and Quarter-over-Quarter).
  - Handles **Currency Conversion** automatically if financial statements are in a different currency than the stock price.
- **Batch Processing**: Supports processing a list of symbols concurrently with configurable parallelism.
- **CSV Export**: detailed reports are saved to `output/report.csv` and a flattened key-value format to `output/symbolKeyValues.csv`.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended)
- [Bun](https://bun.sh/) (optional, but used in dev scripts) or `npm`

## Installation

1. Clone the repository.
2. Install dependencies:

```bash
bun install
```

## Usage

### Single Symbol Analysis
To analyze a single stock symbol and print the JSON result to the console:

```bash
# Using Bun
bun run src/main.ts <SYMBOL>

# Example
bun run src/main.ts AAPL
```

### Batch Analysis
To process a list of symbols:

1. Create a CSV file at `input/symbols.csv` with a `symbol` column.
2. Run the script without arguments:

```bash
# Using Bun
bun run src/main.ts
```

The script will:
- Read symbols from `input/symbols.csv`.
- Process a sample (default 100) of these symbols potentially in parallel.
- Save the results to:
  - `output/report.csv`: A wide-format CSV with all calculated metrics.
  - `output/symbolKeyValues.csv`: A long-format CSV useful for pivot tables or database ingestion.

## Project Structure

- `src/main.ts`: Entry point. Handles CLI args and orchestrates the fetching/calculation flow.
- `src/api/`: Contains logic for communicating with Yahoo Finance.
- `src/csv.ts`: Utilities for reading and writing CSV files.
- `src/types.ts`: TypeScript definitions for financial data structures.

## Scripts

- `npm run build`: Compiles TypeScript to JavaScript (uses `tsc`).
- `npm run dev`: Runs the source code directly using `bun`.
- `npm start`: Runs the compiled code from `dist/main.js`.
- `npm run clean`: Removes the `dist` directory.

## License

MIT
