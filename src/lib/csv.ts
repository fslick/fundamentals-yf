import { AsyncParser, type ParserOptions } from "@json2csv/node";
import { parse } from "csv-parse";
import { createReadStream, createWriteStream } from "fs";

export async function saveToCsv<T>(data: T[], filename: string, delimiter: string = ",") {
    const opts: ParserOptions = {
        delimiter,
    };
    const parser = new AsyncParser(opts);

    const writableStream = createWriteStream(filename);

    return new Promise((resolve, reject) => {
        const parsingStream = parser.parse(data);

        parsingStream.pipe(writableStream);

        writableStream.on("finish", resolve);
        writableStream.on("error", reject);
        parsingStream.on("error", reject);
    });
}

export async function parseCsv<T>(filepath: string) {
    const records: T[] = [];
    const parser = createReadStream(filepath).pipe(parse({
        columns: true,
        skip_empty_lines: true
    }));

    for await (const record of parser) {
        records.push(record);
    }
    return records;
}

