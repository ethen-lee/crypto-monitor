import Foundation

struct Asset: Codable, Equatable, Sendable {
    enum Provider: String, Codable, Sendable { case coinbase, yahoo, binance }
    let id: String
    let name: String
    let symbol: String
    let baseAsset: String
    let provider: Provider
    let tickSize: Double

    static let btc = Asset(id: "btc", name: "比特币", symbol: "BTC-USD", baseAsset: "BTC", provider: .coinbase, tickSize: 0.01)
    static let eth = Asset(id: "eth", name: "以太坊", symbol: "ETH-USD", baseAsset: "ETH", provider: .coinbase, tickSize: 0.01)
    static let us10y = Asset(id: "us10y", name: "10 年期美债", symbol: "^TNX", baseAsset: "10Y", provider: .yahoo, tickSize: 0.001)
    static let us30y = Asset(id: "us30y", name: "30 年期美债", symbol: "^TYX", baseAsset: "30Y", provider: .yahoo, tickSize: 0.001)
    static let gold = Asset(id: "gold", name: "黄金永续", symbol: "XAUUSDT", baseAsset: "XAU", provider: .binance, tickSize: 0.01)
    static let defaults: [Asset] = [.btc, .eth, .us10y, .us30y, .gold]

    var label: String { isBinance ? "\(baseAsset)·P" : baseAsset }
    var isCoinbase: Bool { provider == .coinbase }
    var isYield: Bool { provider == .yahoo }
    var isBinance: Bool { provider == .binance }
    var cacheKey: String { "\(provider.rawValue):\(isBinance ? "perpetual" : isYield ? "yield" : "spot"):\(symbol)" }
    var isCustom: Bool { !Self.defaults.contains(where: { $0.id == id }) }
    var priceDecimals: Int {
        let fraction = String(format: "%.12f", locale: Locale(identifier: "en_US_POSIX"), tickSize).split(separator: ".").last ?? ""
        return fraction.replacingOccurrences(of: "0+$", with: "", options: .regularExpression).count
    }
    var tradingViewSymbol: String {
        if isBinance { return "BINANCE:\(symbol).P" }
        if isCoinbase { return "COINBASE:\(baseAsset)USD" }
        return "TVC:US\(baseAsset)"
    }

    static func perpetual(symbol: String, baseAsset: String, tickSize: Double) -> Asset? {
        guard symbol.hasSuffix("USDT"), !baseAsset.isEmpty,
              symbol.range(of: "^[\\p{L}\\p{N}_]{1,60}$", options: .regularExpression) != nil,
              baseAsset.range(of: "^[\\p{L}\\p{N}_]{1,50}$", options: .regularExpression) != nil,
              tickSize.isFinite, tickSize >= 0.000000000001, tickSize <= 1_000_000 else { return nil }
        if symbol == gold.symbol { return gold }
        return Asset(id: "binance:perpetual:\(symbol)", name: baseAsset, symbol: symbol, baseAsset: baseAsset, provider: .binance, tickSize: tickSize)
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
    let asset: String
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
    let asset: String
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
    case message(String)
    var errorDescription: String? {
        switch self {
        case .invalidResponse: return "行情源返回了无法读取的数据，请稍后重试。"
        case .unavailable(let status): return "行情源暂不可用（HTTP \(status)），请稍后重试。"
        case .noData: return "行情源暂未提供这个周期的数据。"
        case .unsupportedInterval: return "这个品种不支持所选周期。"
        case .message(let message): return message
        }
    }
}

actor MarketClient {
    private let session: URLSession
    private let cacheURL: URL
    private var stored: StoredData
    private var catalog: [Asset] = []
    private var catalogFetchedAt = Date.distantPast
    private var catalogRequest: Task<[Asset], Error>?
    private var activeRequests = 0
    private var hostBackoff: [String: Date] = [:]

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
        // Only migrate unchanged markets. Legacy gold keys contain COMEX futures.
        for asset in Asset.defaults where !asset.isBinance {
            if stored.quotes[asset.cacheKey] == nil { stored.quotes[asset.cacheKey] = stored.quotes[asset.id] }
            for interval in ["1m", "15m", "1h", "6h", "1d", "1w"] {
                let key = asset.cacheKey + ":" + interval
                if stored.histories[key] == nil { stored.histories[key] = stored.histories[asset.id + ":" + interval] }
            }
        }
    }

    func cachedSnapshot(assets: [Asset]) -> Snapshot {
        Snapshot(quotes: assets.compactMap { asset in
            guard var quote = stored.quotes[asset.cacheKey] else { return nil }
            quote.cached = true
            return quote
        }, errors: [:])
    }

    func snapshot(assets: [Asset], force: Bool = false) async -> Snapshot {
        var quotes: [Quote] = []
        var errors: [String: String] = [:]
        await withTaskGroup(of: (Asset, Quote?, String?).self) { group in
            for asset in assets {
                group.addTask {
                    do { return (asset, try await self.quote(asset, force: force), nil) }
                    catch { return (asset, nil, error.localizedDescription) }
                }
            }
            for await (asset, quote, error) in group {
                if let quote { quotes.append(quote) }
                if let error {
                    errors[asset.id] = error
                    if var cached = stored.quotes[asset.cacheKey] {
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
        if !force, let cached = stored.quotes[asset.cacheKey], now - cached.fetchedAt < (asset.isYield ? 55 : 25) {
            return cached
        }
        let quote: Quote
        if asset.isBinance {
            let data = try await request(host: "fapi.binance.com", path: "/fapi/v1/ticker/24hr", query: ["symbol": asset.symbol])
            let ticker = try JSONDecoder().decode(BinanceTicker.self, from: data)
            guard ticker.symbol == asset.symbol,
                  let price = Double(ticker.lastPrice), price.isFinite, price > 0,
                  ticker.closeTime.isFinite, ticker.closeTime > 0 else { throw MarketError.invalidResponse }
            quote = Quote(asset: asset.id, price: price, change: try finiteNumber(ticker.priceChange),
                          changePercent: try finiteNumber(ticker.priceChangePercent), high: try finiteNumber(ticker.highPrice),
                          low: try finiteNumber(ticker.lowPrice), volume: try finiteNumber(ticker.volume),
                          timestamp: ticker.closeTime / 1000, fetchedAt: now)
        } else if asset.isCoinbase {
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
            quote = Quote(asset: asset.id, price: price, change: price - open, changePercent: (price / open - 1) * 100,
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
            quote = Quote(asset: asset.id, price: price, change: change, changePercent: percent,
                          high: meta.regularMarketDayHigh, low: meta.regularMarketDayLow,
                          volume: asset.isYield ? nil : meta.regularMarketVolume,
                          timestamp: timestamp, fetchedAt: now)
        }
        stored.quotes[asset.cacheKey] = quote
        return quote
    }

    func history(_ asset: Asset, interval: String, force: Bool = false) async throws -> History {
        let supported = asset.isYield ? ["1d", "1w"] : ["1m", "15m", "1h", "6h", "1d", "1w"]
        guard supported.contains(interval) else { throw MarketError.unsupportedInterval }
        let key = asset.cacheKey + ":" + interval
        let now = Date().timeIntervalSince1970
        if !force, let cached = stored.histories[key], now - cached.fetchedAt < (interval == "1m" ? 10 : 55) { return cached }
        do {
            let candles: [Candle]
            if asset.isBinance {
                let data = try await request(host: "fapi.binance.com", path: "/fapi/v1/klines", query: [
                    "symbol": asset.symbol, "interval": interval, "limit": "1000",
                ])
                guard let rows = try JSONSerialization.jsonObject(with: data) as? [[Any]] else { throw MarketError.invalidResponse }
                candles = normalize(try rows.map { row in
                    guard row.count >= 6, let timestamp = row[0] as? NSNumber,
                          let open = row[1] as? String, let high = row[2] as? String, let low = row[3] as? String,
                          let close = row[4] as? String, let volume = row[5] as? String else { throw MarketError.invalidResponse }
                    return Candle(time: timestamp.intValue / 1000, open: try finiteNumber(open), high: try finiteNumber(high),
                                  low: try finiteNumber(low), close: try finiteNumber(close), volume: try finiteNumber(volume))
                })
            } else if asset.isCoinbase {
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
            let history = History(asset: asset.id, interval: interval, candles: candles, fetchedAt: now)
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

    func perpetualCatalog(force: Bool = false) async throws -> [Asset] {
        if !force, Date().timeIntervalSince(catalogFetchedAt) < 300 { return catalog }
        if let catalogRequest { return try await catalogRequest.value }
        let task = Task { try await self.fetchPerpetualCatalog() }
        catalogRequest = task
        defer { catalogRequest = nil }
        let result = try await task.value
        catalog = result
        catalogFetchedAt = Date()
        return result
    }

    private func fetchPerpetualCatalog() async throws -> [Asset] {
        let data = try await request(host: "fapi.binance.com", path: "/fapi/v1/exchangeInfo")
        let info = try JSONDecoder().decode(BinanceExchangeInfo.self, from: data)
        let assets = info.symbols.compactMap { item -> Asset? in
            guard item.status == "TRADING", ["PERPETUAL", "TRADIFI_PERPETUAL"].contains(item.contractType),
                  item.quoteAsset == "USDT", item.marginAsset == "USDT",
                  let tick = item.filters.first(where: { $0.filterType == "PRICE_FILTER" })?.tickSize,
                  let tickSize = Double(tick) else { return nil }
            return Asset.perpetual(symbol: item.symbol, baseAsset: item.baseAsset, tickSize: tickSize)
        }
        guard !assets.isEmpty else { throw MarketError.noData }
        return assets.sorted { $0.symbol < $1.symbol }
    }

    private func finiteNumber(_ value: String) throws -> Double {
        guard let number = Double(value), number.isFinite else { throw MarketError.invalidResponse }
        return number
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
        while activeRequests >= 3 { try await Task.sleep(nanoseconds: 100_000_000) }
        if let until = hostBackoff[host], until > Date() {
            throw MarketError.message("行情源暂缓请求，\(Int(ceil(until.timeIntervalSinceNow))) 秒后可重试。")
        }
        activeRequests += 1
        defer { activeRequests -= 1 }
        var components = URLComponents()
        components.scheme = "https"
        components.host = host
        components.path = path
        components.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        guard let url = components.url else { throw MarketError.invalidResponse }
        let (data, response) = try await session.data(from: url)
        guard let response = response as? HTTPURLResponse else { throw MarketError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let status = response.statusCode
            if [403, 418, 429, 451].contains(status) {
                var delay: Double = status == 429 ? 60 : 3600
                if let retry = response.value(forHTTPHeaderField: "Retry-After") {
                    if let seconds = Double(retry) { delay = max(delay, seconds) }
                    else {
                        let parser = DateFormatter()
                        parser.locale = Locale(identifier: "en_US_POSIX")
                        parser.dateFormat = "EEE, dd MMM yyyy HH:mm:ss z"
                        if let date = parser.date(from: retry) { delay = max(delay, date.timeIntervalSinceNow) }
                    }
                }
                hostBackoff[host] = Date().addingTimeInterval(delay)
            }
            throw MarketError.unavailable(status)
        }
        return data
    }

    private func save() {
        if let data = try? JSONEncoder().encode(stored) { try? data.write(to: cacheURL, options: .atomic) }
    }
}

private struct CoinbaseStats: Decodable { let open, high, low, volume: String }
private struct CoinbaseTicker: Decodable { let price, time: String }
private struct BinanceTicker: Decodable {
    let symbol, lastPrice, priceChange, priceChangePercent, highPrice, lowPrice, volume: String
    let closeTime: Double
}
private struct BinanceExchangeInfo: Decodable {
    let symbols: [Symbol]
    struct Symbol: Decodable {
        let symbol, baseAsset, quoteAsset, marginAsset, contractType, status: String
        let filters: [Filter]
    }
    struct Filter: Decodable { let filterType: String; let tickSize: String? }
}
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
