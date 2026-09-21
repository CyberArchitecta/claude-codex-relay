"""Browser regressions against an isolated real server and fixture providers.
Requires Python Playwright and Chromium. No provider login or model calls.
"""
import json
import subprocess
from pathlib import Path
from urllib.request import Request, urlopen
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
server = subprocess.Popen(
    ["node", "test/fixtures/ui-server.mjs"], cwd=ROOT,
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
)
try:
    boot = json.loads(server.stdout.readline())
    base, token = boot["url"].split("/#token=")
    headers = {"Authorization": "Bearer " + token, "Content-Type": "application/json"}

    def api(route, data=None):
        req = Request(base + "/api" + route, headers=headers, data=None if data is None else json.dumps(data).encode())
        with urlopen(req, timeout=10) as response:
            return json.load(response)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 1100})
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        page.goto(boot["url"])
        page.get_by_text("Connected locally", exact=True).wait_for()

        def choose(title):
            page.get_by_role("button", name=title, exact=False).click()
            expect(page.locator("#detail-title")).to_have_text(title)

        def create(title, start=False):
            page.locator("#new-task").click()
            page.locator("#new-title").fill(title)
            page.locator("#new-project").fill(boot["project"])
            page.locator("#new-prompt").fill("Fixture task for browser verification.")
            page.locator("#new-agent").select_option("codex")
            page.locator("#new-permission").select_option("read-only")
            if start:
                page.get_by_role("button", name="Create & run", exact=False).click()
            else:
                page.locator("#create-only").click()
            expect(page.locator("#detail-title")).to_have_text(title)
            return next(t for t in api("/tasks")["tasks"] if t["title"] == title)

        choose("Existing task")
        expect(page.locator("#run-model")).to_have_value("previous-custom-model")
        expect(page.locator("#run-permission")).to_have_value("workspace-write")
        draft = create("New draft")
        expect(page.locator("#run-agent")).to_have_value("codex")
        expect(page.locator("#run-permission")).to_have_value("read-only")
        expect(page.locator("#run-model")).to_have_value("")
        assert not api("/tasks/" + draft["id"])["runs"]

        choose("Existing task")
        choose("New draft")
        expect(page.locator("#run-permission")).to_have_value("read-only")
        expect(page.locator("#run-model")).to_have_value("")

        choose("Existing task")
        page.locator(".context-panel summary").click()
        route = "/tasks/" + boot["task"]["id"] + "/context"
        api(route, {"context": "Remote note."})
        expect(page.locator("#shared-context")).to_have_value("Remote note.", timeout=7000)
        page.locator("#shared-context").fill("Remote note.\nLocal unsaved decision.")
        api(route, {"context": "Remote note.\nAnother client's decision."})
        expect(page.locator("#context-conflict")).to_be_visible(timeout=7000)
        expect(page.locator("#shared-context")).to_have_value("Remote note.\nLocal unsaved decision.")
        expect(page.locator("#save-context")).to_be_disabled()
        choose("New draft")
        choose("Existing task")
        expect(page.locator("#shared-context")).to_have_value("Remote note.\nLocal unsaved decision.")
        expect(page.locator("#latest-context")).to_have_text("Remote note.\nAnother client's decision.")
        merged = "Remote note.\nAnother client's decision.\nLocal unsaved decision."
        page.locator("#shared-context").fill(merged)
        page.locator("#save-merged-context").click()
        expect(page.locator("#context-conflict")).to_be_hidden()
        expect(page.locator("#notice")).to_contain_text("Shared context saved")
        assert api("/tasks/" + boot["task"]["id"])["task"]["context"] == merged

        # Write between clicking Save and the POST reaching the server.
        page.locator("#shared-context").fill(merged + "\nRacing local edit.")
        def concurrent_write(intercepted):
            api(route, {"context": merged + "\nConcurrent remote edit."})
            intercepted.continue_()
        pattern = "**/api" + route
        page.route(pattern, concurrent_write)
        with page.expect_response(lambda response: response.url.endswith("/context") and response.request.method == "POST") as response:
            page.locator("#save-context").click()
        assert response.value.status == 409
        page.unroute(pattern, concurrent_write)
        expect(page.locator("#context-conflict")).to_be_visible()
        expect(page.locator("#notice")).to_contain_text("changed elsewhere")
        expect(page.locator("#shared-context")).to_have_value(merged + "\nRacing local edit.")
        assert api("/tasks/" + boot["task"]["id"])["task"]["context"] == merged + "\nConcurrent remote edit."
        page.locator("#use-latest-context").click()
        expect(page.locator("#context-conflict")).to_be_hidden()
        expect(page.locator("#shared-context")).to_have_value(merged + "\nConcurrent remote edit.")

        # A newly started task must receive the form choices and no old model.
        started = create("New running task", start=True)
        expect(page.locator("#run-history .status")).to_have_text("Completed", timeout=15000)
        run = api("/tasks/" + started["id"])["runs"][0]
        assert (run["agent"], run["permission"], run["model"]) == ("codex", "read-only", "")

        # General chat creates no model request until the first message.
        page.locator("#new-task").click()
        page.locator("#new-title").fill("Projectless conversation")
        page.locator("#new-kind").select_option("chat")
        page.locator("#create-only").click()
        expect(page.locator("#detail-title")).to_have_text("Projectless conversation")
        expect(page.locator("#detail-project")).to_have_text("General chat")
        expect(page.locator("#run-permission")).to_be_disabled()
        page.locator("#run-agent").select_option("claude")
        page.locator("#run-note").fill("Remember the marker CHAT-BLUE.")
        page.locator("#run-note").press("Enter")
        expect(page.locator("#run-history .status")).to_have_text("Completed", timeout=15000)
        expect(page.locator(".user-message")).to_contain_text("CHAT-BLUE")
        page.locator("#run-agent").select_option("codex")
        page.locator("#run-note").fill("What did Claude say?")
        page.locator("#preview").click()
        expect(page.locator("#preview-text")).to_contain_text("CHAT-BLUE")
        page.locator("#close-preview").click()
        page.locator("#run-note").press("Enter")
        expect(page.locator("#run-history .status").last).to_have_text("Completed", timeout=15000)
        expect(page.locator(".usage-line")).to_have_count(2)
        expect(page.locator("#chat-usage")).to_contain_text("Claude Code:")
        expect(page.locator("#chat-usage")).to_contain_text("Codex:")
        page.locator("#usage-button").click()
        expect(page.locator("#usage-totals")).to_contain_text("cached input")
        expect(page.locator("#usage-totals")).to_contain_text("USD")
        page.locator("#close-usage").click()
        assert not errors, errors
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        page.set_viewport_size({"width": 390, "height": 844})
        assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
        browser.close()
    print("Browser regressions passed: draft defaults, form choices, live notes, preserved drafts, merge, stale-save rejection, task switching, desktop/mobile, no page errors.")
finally:
    server.stdin.close()
    try:
        server.wait(timeout=15)
    except subprocess.TimeoutExpired:
        server.kill()
        server.wait()
        raise
    if server.returncode:
        raise RuntimeError(server.stderr.read())
