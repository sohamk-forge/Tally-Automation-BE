def success_response(summary, records):
    return {
        "summary": summary,
        "records": records

    }
def error_response(message):
    return {
        "status": "error",
        "message": message
    }