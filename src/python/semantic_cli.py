import sys
import json
from semantic import process_transactions


def main():
    raw = sys.stdin.read()
    try:
        transactions = json.loads(raw)
    except Exception as e:
        print(json.dumps({"error": f"invalid input: {e}"}))
        sys.exit(1)

    try:
        result = process_transactions(transactions)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)


if __name__ == "__main__":
    main()