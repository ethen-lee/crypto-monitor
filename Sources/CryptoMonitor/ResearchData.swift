import Foundation

enum ResearchDataset: String, Codable, Sendable {
    case perpetual, spot, bitcoin, ratio, interest, funding, reference

    var symbol: String { self == .bitcoin ? "BTCUSDT" : self == .ratio ? "ETHBTC" : "ETHUSDT" }
    var isSpot: Bool { [.spot, .bitcoin, .ratio].contains(self) }
    var isBar: Bool { [.perpetual, .spot, .bitcoin, .ratio].contains(self) }
    var ttl: Double { [.interest, .funding].contains(self) ? 300 : 60 }
}

struct ResearchBar: Codable, Sendable {
    let time: Int
    let endTime: Double
    let open: Double
    let high: Double
    let low: Double
    let close: Double
    let volume: Double
    let takerBuy: Double
}

struct ResearchPoint: Codable, Sendable {
    let time: Double
    let value: Double
    var notional: Double? = nil
    var rateType: String? = nil
}

struct PriceReference: Codable, Sendable {
    let mark: Double
    let index: Double
    let rate: Double
    let nextFundingTime: Double
}

struct ResearchSeries: Codable, Sendable {
    let dataset: ResearchDataset
    let source: String
    let market: String
    let symbol: String
    let interval: String
    let unit: String
    let nature: String
    let requestedStart: Double
    var fetchedAt: Double
    var sourceTime: Double
    let sourceTimeKind: String
    var bars: [ResearchBar] = []
    var points: [ResearchPoint] = []
    var reference: PriceReference? = nil
    var cached = false
    var warning: String? = nil
}

private struct ResearchFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

/// A separate public-market cache keeps provider, contract and interval identities intact.
actor ResearchClient {
    private let session: URLSession
    private let cacheURL: URL
    private var stored: [String: ResearchSeries]
    private var inFlight: [String: Task<ResearchSeries, Error>] = [:]
    private var retryAfter: [String: Date] = [:]
    private var hostBackoff: [String: Date] = [:]
    private var failures: [String: Int] = [:]
    private var activeRequests = 0
    private let day = 86400.0

    init() {
        let config = URLSessionConfiguration.ephemeral
        config.timeoutIntervalForRequest = 15
        config.timeoutIntervalForResource = 20
        config.httpAdditionalHeaders = ["User-Agent": "CryptoMonitor/0.1", "Accept": "application/json"]
        session = URLSession(configuration: config)
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("CryptoMonitor", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        cacheURL = directory.appendingPathComponent("research-cache-v1.json")
        stored = (try? JSONDecoder().decode([String: ResearchSeries].self, from: Data(contentsOf: cacheURL))) ?? [:]
    }

    func cachedSeries(_ dataset: ResearchDataset, interval: String) -> ResearchSeries? {
        guard ["1h", "4h", "1d"].contains(interval) else { return nil }
        let period = dataset == .funding ? "settlement" : dataset == .reference ? "snapshot" : interval
        return stored["binance:\(dataset.rawValue):\(dataset.symbol):\(period)"]
    }

    func series(_ dataset: ResearchDataset, interval: String, force: Bool = false) async throws -> ResearchSeries {
        guard ["1h", "4h", "1d"].contains(interval) else { throw MarketError.unsupportedInterval }
        let period = dataset == .funding ? "settlement" : dataset == .reference ? "snapshot" : interval
        let key = "binance:\(dataset.rawValue):\(dataset.symbol):\(period)"
        if let task = inFlight[key] { return try await task.value }
        if let cached = stored[key], !force, Date().timeIntervalSince1970 - cached.fetchedAt < dataset.ttl { return cached }
        if let until = retryAfter[key], until > Date() {
            return try fallback(key, reason: "暂缓重试，保留上次数据（\(Int(ceil(until.timeIntervalSinceNow))) 秒后可重试）。")
        }
        let task = Task { try await self.fetch(dataset, interval: interval, key: key) }
        inFlight[key] = task
        defer { inFlight[key] = nil }
        do {
            let result = try await task.value
            stored[key] = result
            failures[key] = nil
            retryAfter[key] = nil
            if let data = try? JSONEncoder().encode(stored) { try? data.write(to: cacheURL, options: .atomic) }
            return result
        } catch {
            let count = min((failures[key] ?? 0) + 1, 5)
            failures[key] = count
            retryAfter[key] = Date().addingTimeInterval(min(900, 30 * pow(2, Double(count - 1))))
            return try fallback(key, reason: error.localizedDescription)
        }
    }

    private func fallback(_ key: String, reason: String) throws -> ResearchSeries {
        guard var value = stored[key] else { throw ResearchFailure(message: reason) }
        value.cached = true
        value.warning = reason
        return value
    }

    private func fetch(_ dataset: ResearchDataset, interval: String, key: String) async throws -> ResearchSeries {
        let now = Date().timeIntervalSince1970
        let step = interval == "1d" ? day : interval == "4h" ? 14400.0 : 3600.0
        let lookback = dataset == .funding ? 90.0 : dataset == .interest ? 29.0 : interval == "1d" ? 730.0 : interval == "4h" ? 180.0 : 60.0
        let start = floor((now - lookback * day) / step) * step
        let old = stored[key]
        var result = ResearchSeries(
            dataset: dataset, source: "Binance 公共 REST API", market: dataset.isSpot ? "现货" : "USDⓈ-M 永续",
            symbol: dataset.symbol, interval: dataset == .funding ? "逐次结算" : dataset == .reference ? "快照" : interval,
            unit: dataset == .ratio ? "BTC / ETH" : dataset == .interest ? "ETH；名义金额 USD" : dataset == .funding ? "费率（小数）" : "价格 USDT；成交量基币",
            nature: "平台报告", requestedStart: old?.requestedStart ?? start, fetchedAt: now, sourceTime: now,
            sourceTimeKind: dataset.isBar ? "最新 K 线起点" : dataset == .interest ? "统计期末" : dataset == .funding ? "最近结算" : "源快照时间"
        )
        if dataset.isBar {
            // Refresh an overlapping tail; only initial loads or gaps require backfill.
            var cursor = max(start, Double(old?.bars.last?.time ?? Int(start)) - step)
            var bars = old?.bars.filter { Double($0.time) >= start } ?? []
            var pages = 0
            while cursor < now && pages < 8 {
                let raw = try await request(spot: dataset.isSpot, path: dataset.isSpot ? "/api/v3/klines" : "/fapi/v1/klines", query: [
                    "symbol": dataset.symbol, "interval": interval, "limit": "1000", "startTime": millis(cursor), "endTime": millis(now),
                ])
                guard let rows = raw as? [[Any]] else { throw MarketError.invalidResponse }
                if rows.isEmpty { break }
                let parsed = try rows.map(parseBar)
                guard let last = parsed.last, Double(last.time) >= cursor else { throw MarketError.invalidResponse }
                bars += parsed
                cursor = Double(last.time) + step
                pages += 1
                if rows.count < 1000 { break }
            }
            result.bars = Array(Dictionary(bars.map { ($0.time, $0) }, uniquingKeysWith: { _, new in new }).values).sorted { $0.time < $1.time }
            guard let last = result.bars.last else { throw MarketError.noData }
            result.sourceTime = Double(last.time)
            if zip(result.bars, result.bars.dropFirst()).contains(where: { Double($1.time - $0.time) != step }) {
                result.warning = "K 线历史有缺口；累计指标在缺口处停止，不跨缺口累计。"
            }
        } else if dataset == .interest {
            // The endpoint retains about one month. Use a safe 29-day range; keep older local samples.
            var cursor = max(start, (old?.points.last?.time ?? start) - step)
            var points = old?.points.filter { $0.time >= now - 730 * day } ?? []
            var pages = 0
            while cursor < now && pages < 3 {
                let windowEnd = min(now, cursor + step * 499)
                let raw = try await request(spot: false, path: "/futures/data/openInterestHist", query: [
                    "symbol": dataset.symbol, "period": interval, "limit": "500", "startTime": millis(cursor), "endTime": millis(windowEnd),
                ])
                guard let rows = raw as? [[String: Any]] else { throw MarketError.invalidResponse }
                if rows.isEmpty { break }
                let parsed = try rows.map { row -> ResearchPoint in
                    let time = try number(row["timestamp"]) / 1000
                    let value = try number(row["sumOpenInterest"])
                    let notional = try number(row["sumOpenInterestValue"])
                    guard value >= 0, notional >= 0 else { throw MarketError.invalidResponse }
                    return ResearchPoint(time: time, value: value, notional: notional)
                }
                guard let last = parsed.last, last.time >= cursor else { throw MarketError.invalidResponse }
                points += parsed
                cursor = max(last.time, windowEnd) + 0.001
                pages += 1
            }
            result.points = unique(points)
            guard let last = result.points.last else { throw MarketError.noData }
            result.sourceTime = last.time
        } else if dataset == .funding {
            var cursor = max(start, (old?.points.last?.time ?? start) - day)
            var points = old?.points.filter { $0.time >= now - 730 * day } ?? []
            var pages = 0
            while cursor <= now && pages < 10 {
                let raw = try await request(spot: false, path: "/fapi/v1/fundingRate", query: [
                    "symbol": dataset.symbol, "startTime": millis(cursor), "endTime": millis(now), "limit": "1000",
                ])
                guard let rows = raw as? [[String: Any]] else { throw MarketError.invalidResponse }
                if rows.isEmpty { break }
                let parsed = try rows.map { row in
                    ResearchPoint(time: try number(row["fundingTime"]) / 1000, value: try number(row["fundingRate"]), rateType: row["rateType"] as? String ?? "Regular")
                }
                guard let last = parsed.last, last.time >= cursor else { throw MarketError.invalidResponse }
                points += parsed
                cursor = last.time + 0.001
                pages += 1
                if rows.count < 1000 { break }
            }
            // Preserve distinct regular/special settlement records at the same timestamp.
            result.points = unique(points)
            guard let last = result.points.last else { throw MarketError.noData }
            result.sourceTime = last.time
            if pages == 10 { result.warning = "回补达到本轮请求上限，资金费历史可能不完整。" }
        } else {
            let raw = try await request(spot: false, path: "/fapi/v1/premiumIndex", query: ["symbol": dataset.symbol])
            guard let row = raw as? [String: Any] else { throw MarketError.invalidResponse }
            result.sourceTime = try number(row["time"]) / 1000
            result.reference = PriceReference(mark: try number(row["markPrice"]), index: try number(row["indexPrice"]), rate: try number(row["lastFundingRate"]), nextFundingTime: try number(row["nextFundingTime"]) / 1000)
        }
        result.fetchedAt = Date().timeIntervalSince1970
        return result
    }

    private func unique(_ points: [ResearchPoint]) -> [ResearchPoint] {
        Array(Dictionary(points.map { ("\($0.time):\($0.rateType ?? "")", $0) }, uniquingKeysWith: { _, new in new }).values)
            .sorted { $0.time == $1.time ? ($0.rateType ?? "") < ($1.rateType ?? "") : $0.time < $1.time }
    }

    private func number(_ value: Any?) throws -> Double {
        let result: Double?
        if let string = value as? String { result = Double(string) }
        else { result = (value as? NSNumber)?.doubleValue }
        guard let result, result.isFinite else { throw MarketError.invalidResponse }
        return result
    }

    private func parseBar(_ row: [Any]) throws -> ResearchBar {
        guard row.count >= 11 else { throw MarketError.invalidResponse }
        let values = try [0, 1, 2, 3, 4, 5, 6, 9].map { try number(row[$0]) }
        guard values[0] > 0, values[1...4].allSatisfy({ $0 > 0 }), values[2] >= max(values[1], values[4]),
              values[3] <= min(values[1], values[4]), values[5] >= 0, values[7] >= 0, values[7] <= values[5] else { throw MarketError.invalidResponse }
        return ResearchBar(time: Int(values[0] / 1000), endTime: values[6] / 1000, open: values[1], high: values[2], low: values[3], close: values[4], volume: values[5], takerBuy: values[7])
    }

    private func millis(_ seconds: Double) -> String { String(Int64((seconds * 1000).rounded())) }

    private func request(spot: Bool, path: String, query: [String: String]) async throws -> Any {
        let host = spot ? "api.binance.com" : "fapi.binance.com"
        while activeRequests >= 3 { try await Task.sleep(nanoseconds: 100_000_000) }
        if let until = hostBackoff[host], until > Date() {
            throw ResearchFailure(message: "数据源正在退避，\(Int(ceil(until.timeIntervalSinceNow))) 秒后再试。")
        }
        activeRequests += 1
        defer { activeRequests -= 1 }
        var url = URLComponents()
        url.scheme = "https"; url.host = host; url.path = path
        url.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        guard let destination = url.url else { throw MarketError.invalidResponse }
        let (data, response) = try await session.data(from: destination)
        guard let response = response as? HTTPURLResponse else { throw MarketError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let status = response.statusCode
            if [403, 418, 429, 451].contains(status) {
                let minimum: Double = status == 429 ? 60 : 3600
                var delay = minimum
                if let retry = response.value(forHTTPHeaderField: "Retry-After") {
                    if let seconds = Double(retry) { delay = max(delay, seconds) }
                    else {
                        let formatter = DateFormatter()
                        formatter.locale = Locale(identifier: "en_US_POSIX")
                        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss z"
                        if let date = formatter.date(from: retry) { delay = max(delay, date.timeIntervalSinceNow) }
                    }
                }
                hostBackoff[host] = Date().addingTimeInterval(delay)
                throw ResearchFailure(message: "Binance 暂不可用（HTTP \(status)），可能限流或受访问限制；暂停请求，不切换其他平台拼接数据。")
            }
            throw MarketError.unavailable(status)
        }
        return try JSONSerialization.jsonObject(with: data)
    }
}
