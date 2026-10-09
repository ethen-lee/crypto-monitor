import Foundation

enum Asset: String, CaseIterable, Codable, Sendable {
    case btc, eth, us10y, us30y, gold

    var symbol: String {
        switch self {
        case .btc: return "BTC-USD"
        case .eth: return "ETH-USD"
        case .us10y: return "^TNX"
        case .us30y: return "^TYX"
        case .gold: return "GC=F"
        }
    }
    var label: String {
        switch self {
        case .btc: return "BTC"
        case .eth: return "ETH"
        case .us10y: return "10Y"
        case .us30y: return "30Y"
        case .gold: return "黄金"
        }
    }
    var isCrypto: Bool { self == .btc || self == .eth }
    var isYield: Bool { self == .us10y || self == .us30y }

    var tradingViewSymbol: String {
        switch self {
        case .btc: return "COINBASE:BTCUSD"
        case .eth: return "COINBASE:ETHUSD"
        case .us10y: return "TVC:US10Y"
        case .us30y: return "TVC:US30Y"
        case .gold: return "COMEX:GC1!"
        }
    }
}

struct Candle: Codable, Sendable {
    let time: Int
    let open: Double
    let high: Double
    let low: Double
    let close: Double
    let volume: Double?
}

struct Quote: Codable, Sendable {
    let asset: Asset
    let price: Double
    let change: Double?
    let changePercent: Double?
    let high: Double?
    let low: Double?
    let volume: Double?
    let timestamp: Double
    let fetchedAt: Double
    var cached = false
}

struct History: Codable, Sendable {
    let asset: Asset
    let interval: String
    let candles: [Candle]
    let fetchedAt: Double
    var cached = false
}

struct Snapshot: Codable, Sendable {
    let quotes: [Quote]
    let errors: [String: String]
}

private struct StoredData: Codable {
    var quotes: [String: Quote] = [:]
    var histories: [String: History] = [:]
}

enum MarketError: LocalizedError {
    case invalidResponse, unavailable(Int), noData, unsupportedInterval
    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "行情源返回了无法读取的数据，请稍后重试。"
        case .unavailable(let status): return "行情源暂不可用（HTTP \(status)），请稍后重试。"
        case .noData: return "行情源暂未提供这个周期的数据。"
        case .unsupportedInterval: return "这个品种不支持所选周期。"
        }
    }
}

actor MarketClient {
    private let session: URLSession
    private let cacheURL: URL
    private var stored: StoredData

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 20
        config.httpAdditionalHeaders = ["User-Agent": "Mozilla/5.0 CryptoMonitor/0.1", "Accept": "application/json"]
        session = URLSession(configuration: config)
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CryptoMonitor", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        cacheURL = directory.appendingPathComponent("market-cache.json")
        stored = (try? JSONDecoder().decode(StoredData.self, from: Data(contentsOf: cacheURL))) ?? StoredData()
    }

    func cachedSnapshot() -> Snapshot {
        Snapshot(quotes: Asset.allCases.compactMap { asset in
            guard var quote = stored.quotes[asset.rawValue] else { return nil }
            quote.cached = true
            return quote
        }, errors: [:])
    }

    func snapshot(force: Bool = false) async -> Snapshot {
        var quotes: [Quote] = []
        var errors: [String: String] = [:]
        await withTaskGroup(of: (Asset, Quote?, String?).self) { group in
            for asset in Asset.allCases {
                group.addTask {
                    do { return (asset, try await self.quote(asset, force: force), nil) }
                    catch { return (asset, nil, error.localizedDescription) }
                }
            }
            for await (asset, quote, error) in group {
                if let quote { quotes.append(quote) }
                if let error {
                    errors[asset.rawValue] = error
                    if var cached = stored.quotes[asset.rawValue] {
                        cached.cached = true
                        quotes.append(cached)
                    }
                }
            }
        }
        save()
        return Snapshot(quotes: quotes, errors: errors)
    }

    private func quote(_ asset: Asset, force: Bool) async throws -> Quote {
        let now = Date().timeIntervalSince1970
        if !force, let cached = stored.quotes[asset.rawValue], now - cached.fetchedAt < (asset.isCrypto ? 25 : 55) {
            return cached
        }
        let quote: Quote
        if asset.isCrypto {
            async let statsData = request(host: "api.exchange.coinbase.com", path: "/products/\(asset.symbol)/stats")
            async let tickerData = request(host: "api.exchange.coinbase.com", path: "/products/\(asset.symbol)/ticker")
            let stats = try JSONDecoder().decode(CoinbaseStats.self, from: await statsData)
            let ticker = try JSONDecoder().decode(CoinbaseTicker.self, from: await tickerData)
            guard let price = Double(ticker.price), price.isFinite, price > 0,
                  let open = Double(stats.open), open > 0 else { throw MarketError.invalidResponse }
            let parser = ISO8601DateFormatter()
            parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let timestamp = parser.date(from: ticker.time) ?? ISO8601DateFormatter().date(from: ticker.time)
            guard let timestamp else { throw MarketError.invalidResponse }
            quote = Quote(asset: asset, price: price, change: price - open, changePercent: (price / open - 1) * 100,
                          high: Double(stats.high), low: Double(stats.low), volume: Double(stats.volume),
                          timestamp: timestamp.timeIntervalSince1970, fetchedAt: now)
        } else {
            let result = try await yahoo(asset, interval: "1d", range: "5d")
            let meta = result.meta
            guard let price = meta.regularMarketPrice, price.isFinite, price > 0,
                  let timestamp = meta.regularMarketTime else { throw MarketError.invalidResponse }
            let closes = result.indicators.quote.first?.close.compactMap { $0 } ?? []
            let previous = meta.previousClose ?? (closes.count >= 2 ? closes[closes.count - 2] : nil)
            let change = meta.fulldayChange ?? previous.map { price - $0 }
            let reference = change.map { price - $0 }
            let percent = reference.flatMap { $0 > 0 ? (price / $0 - 1) * 100 : nil }
            quote = Quote(asset: asset, price: price, change: change, changePercent: percent,
                          high: meta.regularMarketDayHigh, low: meta.regularMarketDayLow,
                          volume: asset.isYield ? nil : meta.regularMarketVolume,
                          timestamp: timestamp, fetchedAt: now)
        }
        stored.quotes[asset.rawValue] = quote
        return quote
    }

    func history(_ asset: Asset, interval: String, force: Bool = false) async throws -> History {
        let supported = asset.isYield ? ["1d", "1w"] : ["1m", "15m", "1h", "6h", "1d", "1w"]
        guard supported.contains(interval) else { throw MarketError.unsupportedInterval }
        let key = asset.rawValue + ":" + interval
        let now = Date().timeIntervalSince1970
        if !force, let cached = stored.histories[key], now - cached.fetchedAt < (interval == "1m" ? 10 : 55) { return cached }
        do {
            let candles: [Candle]
            if asset.isCrypto {
                let granularity = ["1m": 60, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400, "1w": 86400][interval]!
                let end = Date()
                let start = end.addingTimeInterval(-Double(granularity * 299))
                let formatter = ISO8601DateFormatter()
                let data = try await request(host: "api.exchange.coinbase.com", path: "/products/\(asset.symbol)/candles", query: [
                    "granularity": String(granularity), "start": formatter.string(from: start), "end": formatter.string(from: end),
                ])
                let rows = try JSONDecoder().decode([[Double]].self, from: data)
                let daily = normalize(rows.compactMap { row in
                    guard row.count >= 6 else { return nil }
                    return Candle(time: Int(row[0]), open: row[3], high: row[2], low: row[1], close: row[4], volume: row[5])
                })
                if interval == "1w" {
                    // Do not present an incomplete first week as a full historical candle.
                    let weeks = aggregate(daily, seconds: 604800, offset: 345600)
                    candles = weeks.filter { $0.time >= (daily.first?.time ?? 0) }
                } else {
                    candles = daily
                }
            } else {
                let period = ["1m": ("1m", "5d"), "15m": ("15m", "5d"), "1h": ("1h", "1mo"), "6h": ("1h", "3mo"),
                              "1d": ("1d", "2y"), "1w": ("1wk", "5y")][interval]!
                let result = try await yahoo(asset, interval: period.0, range: period.1)
                guard let times = result.timestamp, let values = result.indicators.quote.first else { throw MarketError.noData }
                let rows = normalize(times.enumerated().compactMap { index, time -> Candle? in
                    guard index < values.open.count, index < values.high.count, index < values.low.count, index < values.close.count,
                          let open = values.open[index], let high = values.high[index], let low = values.low[index],
                          let close = values.close[index] else { return nil }
                    let volume = !asset.isYield && index < (values.volume?.count ?? 0) ? values.volume?[index] : nil
                    return Candle(time: time, open: open, high: high, low: low, close: close, volume: volume)
                })
                // Yahoo appends a current quote with an unaligned timestamp; merge it into its bar.
                let seconds = ["1m": 60, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400, "1w": 604800][interval]!
                candles = aggregate(rows, seconds: seconds, offset: interval == "1w" ? 345600 : 0)
            }
            guard !candles.isEmpty else { throw MarketError.noData }
            let history = History(asset: asset, interval: interval, candles: candles, fetchedAt: now)
            stored.histories[key] = history
            save()
            return history
        } catch {
            if var cached = stored.histories[key] {
                cached.cached = true
                return cached
            }
            throw error
        }
    }

    private func normalize(_ rows: [Candle]) -> [Candle] {
        var byTime: [Int: Candle] = [:]
        for row in rows where row.time > 0 && [row.open, row.high, row.low, row.close].allSatisfy({ $0.isFinite && $0 > 0 }) {
            guard row.high >= max(row.open, row.close), row.low <= min(row.open, row.close), row.high >= row.low else { continue }
            byTime[row.time] = row
        }
        return byTime.values.sorted { $0.time < $1.time }
    }

    private func aggregate(_ candles: [Candle], seconds: Int, offset: Int) -> [Candle] {
        let groups = Dictionary(grouping: candles) { (($0.time - offset) / seconds) * seconds + offset }
        return groups.keys.sorted().compactMap { time in
            guard let rows = groups[time]?.sorted(by: { $0.time < $1.time }), let first = rows.first, let last = rows.last else { return nil }
            let volumes = rows.compactMap(\.volume)
            return Candle(time: time, open: first.open, high: rows.map(\.high).max()!, low: rows.map(\.low).min()!,
                          close: last.close, volume: volumes.isEmpty ? nil : volumes.reduce(0, +))
        }
    }

    private func yahoo(_ asset: Asset, interval: String, range: String) async throws -> YahooResult {
        let data = try await request(host: "query1.finance.yahoo.com", path: "/v8/finance/chart/\(asset.symbol)",
                                     query: ["interval": interval, "range": range])
        let response = try JSONDecoder().decode(YahooEnvelope.self, from: data)
        guard let result = response.chart.result?.first else { throw MarketError.noData }
        return result
    }

    private func request(host: String, path: String, query: [String: String] = [:]) async throws -> Data {
        var components = URLComponents()
        components.scheme = "https"
        components.host = host
        components.path = path
        components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        guard let url = components.url else { throw MarketError.invalidResponse }
        let (data, response) = try await session.data(from: url)
        guard let response = response as? HTTPURLResponse else { throw MarketError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else { throw MarketError.unavailable(response.statusCode) }
        return data
    }

    private func save() {
        if let data = try? JSONEncoder().encode(stored) { try? data.write(to: cacheURL, options: .atomic) }
    }
}

private struct CoinbaseStats: Decodable { let open, high, low, volume: String }
private struct CoinbaseTicker: Decodable { let price, time: String }
private struct YahooEnvelope: Decodable {
    let chart: Chart
    struct Chart: Decodable { let result: [YahooResult]? }
}
private struct YahooResult: Decodable {
    let meta: Meta
    let timestamp: [Int]?
    let indicators: Indicators
    struct Meta: Decodable {
        let regularMarketPrice, regularMarketTime, previousClose, fulldayChange: Double?
        let regularMarketDayHigh, regularMarketDayLow, regularMarketVolume: Double?
    }
    struct Indicators: Decodable {
        let quote: [Values]
    }
    struct Values: Decodable {
        let open, high, low, close: [Double?]
        let volume: [Double?]?
    }
}
