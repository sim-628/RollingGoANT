#!/usr/bin/env python3
"""Live demo validation through the local, fixed validation-only gateway.

This separate opt-in script uses synthetic contact details. It verifies gateway
health reports validate mode, blocks remote POSTs and payment endpoints, and
checks that the final result is a draft rather than a supplier order.
The strict read-only live_browser_smoke.py remains unchanged in scope.
Managed Chromium needs access to its existing NSS database; request controlled
filesystem access through the runner when sandbox restrictions prevent it.
TLS verification stays enabled and this script never changes certificate trust.
"""

import argparse
import getpass
from decimal import Decimal
import json
import os
from pathlib import Path
import re
from urllib.parse import urlparse

from playwright.sync_api import expect, sync_playwright


ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / "artifacts" / "browser"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-url", default="http://127.0.0.1:3013")
    parser.add_argument("--chromium", default="/usr/bin/chromium")
    parser.add_argument("--sites-private", action="store_true", help="Read Sites service access token from hidden stdin; never a supplier API key")
    args = parser.parse_args()
    origin = args.base_url.rstrip("/")
    site_auth = {"OAI-Sites-Authorization": "Bearer " + getpass.getpass("Sites service token (input hidden): ")} if args.sites_private else {}
    ARTIFACTS.mkdir(parents=True, exist_ok=True)
    report = {"mode": "live-demo-validation", "synthetic_contact": True, "api_calls": [],
              "api_errors": [], "blocked": [], "page_errors": [], "image_failures": []}
    responses = {}

    def guard(route):
        request = route.request
        parsed = urlparse(request.url)
        same_origin = f"{parsed.scheme}://{parsed.netloc}" == origin
        allowed_post = same_origin and parsed.path in {
            "/api/availability-check", "/api/orders/validate", "/api/orders"
        }
        platform_post = same_origin and parsed.path.startswith("/cdn-cgi/challenge-platform/")
        if (request.method not in {"GET", "HEAD"} and not (request.method == "POST" and (allowed_post or platform_post))) or "/pay" in parsed.path:
            report["blocked"].append({"method": request.method, "path": parsed.path})
            route.abort()
            return
        if parsed.path.startswith("/api/"):
            if not same_origin or not (parsed.path.startswith("/api/catalog/") or
                                      parsed.path == "/api/health" or allowed_post):
                report["blocked"].append({"method": request.method, "path": parsed.path})
                route.abort()
                return
            report["api_calls"].append({"method": request.method, "path": parsed.path})
        route.continue_(headers={**request.headers, **site_auth} if same_origin else request.headers)

    def record_response(response):
        parsed = urlparse(response.url)
        if f"{parsed.scheme}://{parsed.netloc}" == origin and parsed.path.startswith("/api/"):
            try:
                payload = response.json()
                responses[parsed.path] = payload
                if not response.ok or payload.get("success") is False:
                    report["api_errors"].append({"path": parsed.path, "status": response.status,
                                                 "code": payload.get("error", {}).get("code"),
                                                 "trace_id": payload.get("error", {}).get("trace_id")})
            except Exception:
                pass

    def failed_request(request):
        if request.resource_type == "image":
            report["image_failures"].append({"host": urlparse(request.url).netloc, "failure": request.failure})

    def screenshot(page, name):
        page.screenshot(path=str(ARTIFACTS / f"final{name}-live.png"), full_page=True)
        page.screenshot(path=str(ARTIFACTS / f"final{name}-live.viewport.png"), full_page=False)

    options = {"executable_path": args.chromium, "headless": True, "args": ["--no-sandbox"]}
    proxy_server = os.environ.get("HTTPS_PROXY") or os.environ.get("HTTP_PROXY")
    if proxy_server:
        options["proxy"] = {"server": proxy_server, "bypass": "127.0.0.1,localhost"}
    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(**options)
        context = browser.new_context(viewport={"width": 390, "height": 844},
                                      device_scale_factor=1, is_mobile=True, has_touch=True,
                                      locale="zh-CN", timezone_id="Europe/London")
        context.route("**/*", guard)
        page = context.new_page()
        page.on("response", record_response)
        page.on("requestfailed", failed_request)
        page.on("pageerror", lambda error: report["page_errors"].append(str(error)))
        try:
            # Health uses the same gateway origin and contains no credentials.
            health_response = page.request.get(f"{origin}/api/health", headers=site_auth)
            health = health_response.json()
            assert health_response.ok and health.get("success"), "Gateway health check failed"
            assert health["data"].get("configured") is True, "Live product credentials are not configured"
            assert health["data"].get("order_mode") == "validate", "Refuse any gateway that can create supplier orders"
            report["gateway_mode"] = "validate"
            page.goto(origin, wait_until="domcontentloaded")
            expect(page.locator(".cat-product-card").first).to_be_visible(timeout=30000)
            products = responses["/api/catalog/products"]["data"]["products"]
            product = next(item for item in products if str(item["product_code"]) == "105")
            title = product["title"]
            screenshot(page, "01-home")
            page.get_by_role("button", name=f"查看 {title}", exact=True).scroll_into_view_if_needed()
            screenshot(page, "02-catalog")
            page.get_by_role("button", name=f"查看 {title}", exact=True).click()
            expect(page.get_by_role("heading", name=title, exact=True)).to_be_visible(timeout=30000)
            expect(page.locator(".detail-calendar-note")).to_contain_text("USD", timeout=30000)
            screenshot(page, "03-product")
            product_image = page.locator(".detail-hero-image")
            report["product_image_natural_width"] = product_image.evaluate("node => node.naturalWidth") if product_image.count() else 0
            bookable = page.locator(".detail-calendar-day:not([disabled])")
            assert bookable.count() > 0, "The real product has no bookable date"
            bookable.first.click()
            screenshot(page, "04-calendar")
            page.locator(".detail-mobile-booking").get_by_role("button", name="立即预订", exact=True).click()
            expect(page.get_by_role("heading", name="联系人信息", exact=True)).to_be_visible(timeout=30000)
            page.locator('input[name="family_name"]').fill("ANT")
            page.locator('input[name="first_name"]').fill("DEMO")
            page.locator('input[name="mobile"]').fill("13800000000")
            page.locator('input[name="email"]').fill("ant-browser-demo@example.com")
            page.locator('input[name="country"]').fill("CN")
            page.get_by_label(re.compile(r"^Messaging app")).select_option("contact_way_no_whatsapp")
            page.get_by_label(re.compile(r"^WhatsApp")).fill("8613800000000")
            page.get_by_label(re.compile(r"^Pick-up point")).fill("Berjaya Times Square Entrance (infront Starbucks)")
            page.get_by_label(re.compile(r"^Hotel Pick-Up")).select_option("109227656")
            page.get_by_label(re.compile(r"^Do you stay in this hotel\?")).select_option("109227803")
            page.get_by_role("checkbox").check()
            screenshot(page, "05-booking")
            booking_image = page.locator(".booking-summary img")
            report["booking_image_natural_width"] = booking_image.evaluate("node => node.naturalWidth") if booking_image.count() else 0
            page.get_by_role("button", name="确认预订", exact=True).click()
            outcome = page.locator(".confirmation-page, .form-error").or_(
                page.get_by_role("button", name="确认更新后的价格", exact=True)
            )
            expect(outcome.first).to_be_visible(timeout=30000)
            if page.get_by_role("button", name="确认更新后的价格", exact=True).count():
                report["price_reconfirmed"] = True
                page.get_by_role("button", name="确认更新后的价格", exact=True).click()
            expect(page.get_by_role("heading", name="预订信息已确认", exact=True)).to_be_visible(timeout=30000)
            expect(page).to_have_url(re.compile(r"/#/cashier$"))
            expect(page.locator(".confirmation-page .simple-topbar")).to_contain_text("收银台")
            expect(page.locator(".confirmation-page .ant-badge")).to_have_text("DEMO")
            expect(page.get_by_text("尚未生成正式订单或收取费用。支付及后续功能沿用 RollingGo 现有流程。", exact=True)).to_be_visible()
            expect(page.locator(".checkout-link")).to_have_count(0)
            draft = responses["/api/orders"]["data"]
            assert draft.get("mode") == "validated" and str(draft.get("draft_id", "")).startswith("ANT-")
            assert not draft.get("order_code"), "A demo must not generate a supplier order code"
            quote = draft["quote"]
            displayed = page.locator(".receipt-total strong").inner_text()
            assert Decimal(re.sub(r"[^0-9.-]", "", displayed)) == Decimal(quote["total_amount"])
            assert not report["blocked"] and not report["page_errors"]
            report.update(cashier_reached=True, supplier_order_created=False, draft_id=draft["draft_id"],
                          quote_currency=quote["currency"], quote_total=quote["total_amount"],
                          mobile_overflow=page.evaluate("document.documentElement.scrollWidth > innerWidth + 1"))
            assert not report["mobile_overflow"]
            screenshot(page, "06-cashier")
            report["image_failure_count"] = len(report["image_failures"])
            print(json.dumps({key: report[key] for key in ["mode", "gateway_mode", "cashier_reached", "supplier_order_created",
                                                           "draft_id", "quote_currency", "quote_total", "mobile_overflow",
                                                           "product_image_natural_width", "booking_image_natural_width", "image_failure_count",
                                                           "api_errors", "blocked", "page_errors"]}, ensure_ascii=False, indent=2))
            print("PASS live demo reached cashier through supplier validation only; no supplier order or payment was created.")
        except Exception:
            screenshot(page, "07-validation-blocked")
            raise
        finally:
            (ARTIFACTS / "live-cashier-report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
            context.close()
            browser.close()


if __name__ == "__main__":
    main()
