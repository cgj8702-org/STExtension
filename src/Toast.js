import React, { useEffect } from "react";

/**
 * Toast component – shows a transient message.
 * Props:
 *   message (string) – text to display
 *   type ("success"|"error"|"info") – determines background colour
 *   onClose (function) – called after the toast auto‑closes
 */
export default function Toast({ message, type = "info", onClose }) {
    useEffect(() => {
        const timer = setTimeout(() => {
            onClose && onClose();
        }, 4000);
        return () => clearTimeout(timer);
    }, [onClose]);

    const bg = {
        success: "#4caf50",
        error: "#f44336",
        info: "#2196f3"
    }[type] || "#333";

    const style = {
        position: "fixed",
        bottom: "20px",
        right: "20px",
        background: bg,
        color: "white",
        padding: "12px 20px",
        borderRadius: "4px",
        boxShadow: "0 2px 6px rgba(0,0,0,0.3)",
        zIndex: 1000,
        fontFamily: "sans-serif"
    };

    return <div style={style}>{message}</div>;
}
