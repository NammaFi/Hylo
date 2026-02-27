"""
Yield Alert Checker — Local Script
Calls the Vercel API every 5 minutes to check yield thresholds and send alerts.

Usage:
    pip install requests
    python yield-checker.py

Press Ctrl+C to stop.
"""

import time
import requests
from datetime import datetime

API_URL = "https://hylo-community-hub.vercel.app/api/yield-check"
INTERVAL_SECONDS = 300  # 5 minutes


def check_yields():
    try:
        response = requests.get(API_URL, timeout=30)
        data = response.json()

        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        if data.get("ok"):
            checked = data.get("checked", 0)
            alerts = data.get("alerts", 0)
            print(f"[{timestamp}]  Checked: {checked} assets | Alerts sent: {alerts}")

            if alerts > 0:
                for alert in data.get("alertsSent", []):
                    print(f"    {alert['asset']} -- IY: {alert['yield']}% ({alert['direction']})")
        else:
            error = data.get("error", "Unknown error")
            print(f"[{timestamp}]  {error}")

    except requests.exceptions.Timeout:
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]  Request timed out")
    except requests.exceptions.ConnectionError:
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]  Connection error")
    except Exception as e:
        print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}]  Error: {e}")


def main():
    print("=" * 60)
    print("  Yield Alert Checker")
    print(f"  Checking every {INTERVAL_SECONDS // 60} minutes")
    print(f"  API: {API_URL}")
    print("=" * 60)
    print()

    # Run immediately on start
    check_yields()

    while True:
        time.sleep(INTERVAL_SECONDS)
        check_yields()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n\nStopped.")
