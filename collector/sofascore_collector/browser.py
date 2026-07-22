"""使用標準 Selenium 讀取已由瀏覽器正常載入的 API 回應。

不使用 undetected_chromedriver、不寫入 cookie、不嘗試繞過網站驗證。
若網站拒絕請求，呼叫端必須把失敗視為資料缺失。
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class BrowserPayload:
    endpoint_kind: str
    url: str
    payload: dict[str, Any]


class SeleniumSofaScoreClient:
    def __init__(self, *, headless: bool = False, page_wait_seconds: int = 8) -> None:
        self.headless = headless
        self.page_wait_seconds = page_wait_seconds

    def collect_event(self, event_url: str, event_id: str) -> list[BrowserPayload]:
        try:
            from selenium import webdriver
        except ImportError as error:
            raise RuntimeError(
                "缺少 Selenium。請執行 pip install -e .[browser]，"
                "或改用 import-json 匯入瀏覽器保存的回應。"
            ) from error

        options = webdriver.ChromeOptions()
        if self.headless:
            options.add_argument("--headless=new")
        options.add_argument("--disable-gpu")
        options.add_argument("--no-first-run")
        options.set_capability("goog:loggingPrefs", {"performance": "ALL"})

        driver = webdriver.Chrome(options=options)
        try:
            driver.get(event_url)
            time.sleep(self.page_wait_seconds)
            performance_logs = driver.get_log("performance")
            wanted = {
                "event": f"/api/v1/event/{event_id}",
                "lineups": f"/api/v1/event/{event_id}/lineups",
                "top-performers": f"/api/v1/event/baseball/{event_id}/top-performers",
                "statistics": f"/api/v1/event/{event_id}/statistics",
                "incidents": f"/api/v1/event/{event_id}/incidents",
            }
            response_ids: dict[str, tuple[str, str]] = {}
            for entry in performance_logs:
                message = json.loads(entry["message"])["message"]
                if message.get("method") != "Network.responseReceived":
                    continue
                response = message.get("params", {}).get("response", {})
                url = response.get("url", "")
                for kind, path in wanted.items():
                    if url.split("?", 1)[0].endswith(path) and response.get("status") == 200:
                        response_ids[kind] = (message["params"]["requestId"], url)

            result: list[BrowserPayload] = []
            captured_kinds: set[str] = set()
            for kind, (request_id, url) in response_ids.items():
                try:
                    body = driver.execute_cdp_cmd("Network.getResponseBody", {"requestId": request_id})
                    result.append(BrowserPayload(kind, url, json.loads(body["body"])))
                    captured_kinds.add(kind)
                except Exception as error:
                    # Performance log 可能只保留 request metadata，response body 已被 Chrome 清除。
                    # 下一步在同一已載入頁面的瀏覽器 context 重取；仍不處理或保存 cookie。
                    continue

            missing_kinds = [kind for kind in wanted if kind not in captured_kinds]
            if missing_kinds:
                script = """
                    const paths = arguments[0];
                    const done = arguments[arguments.length - 1];
                    Promise.all(paths.map(async ([kind, path]) => {
                      try {
                        const response = await fetch(path, {
                          credentials: 'same-origin',
                          headers: { 'Accept': 'application/json' }
                        });
                        if (!response.ok) {
                          return { kind, ok: false, status: response.status };
                        }
                        return { kind, ok: true, payload: await response.json(), url: response.url };
                      } catch (error) {
                        return { kind, ok: false, error: String(error) };
                      }
                    })).then(done);
                """
                fetched = driver.execute_async_script(
                    script,
                    [[kind, wanted[kind]] for kind in missing_kinds],
                )
                for item in fetched:
                    if item.get("ok"):
                        result.append(BrowserPayload(item["kind"], item["url"], item["payload"]))
                        captured_kinds.add(item["kind"])

            if not result:
                raise RuntimeError(
                    "瀏覽器未取得可用 SofaScore API 回應；請改用 import-json，"
                    "或確認你有權以該來源蒐集資料。"
                )
            return result
        finally:
            driver.quit()
