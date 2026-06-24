using System;
using System.Collections.Generic;
using System.Text;

namespace RfidBridge
{
    internal static class JsonHelper
    {
        public static string Escape(string value)
        {
            if (value == null) return "";
            return value
                .Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\n", "\\n")
                .Replace("\r", "\\r")
                .Replace("\t", "\\t");
        }

        public static string BuildEvent(string eventName, Dictionary<string, object> fields)
        {
            var sb = new StringBuilder();
            sb.Append("{\"event\":\"").Append(Escape(eventName)).Append("\"");
            if (fields != null)
            {
                foreach (var kv in fields)
                {
                    sb.Append(",\"").Append(Escape(kv.Key)).Append("\":");
                    AppendValue(sb, kv.Value);
                }
            }
            sb.Append("}");
            return sb.ToString();
        }

        private static void AppendValue(StringBuilder sb, object value)
        {
            if (value == null)
            {
                sb.Append("null");
                return;
            }
            if (value is bool b)
            {
                sb.Append(b ? "true" : "false");
                return;
            }
            if (value is int || value is long || value is short || value is byte)
            {
                sb.Append(Convert.ToString(value));
                return;
            }
            sb.Append("\"").Append(Escape(Convert.ToString(value))).Append("\"");
        }

        public static Dictionary<string, string> ParseObject(string json)
        {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (string.IsNullOrEmpty(json)) return result;

            json = json.Trim();
            if (!json.StartsWith("{") || !json.EndsWith("}")) return result;

            json = json.Substring(1, json.Length - 2);
            int i = 0;
            while (i < json.Length)
            {
                SkipWhitespace(json, ref i);
                if (i >= json.Length) break;

                string key = ReadString(json, ref i);
                SkipWhitespace(json, ref i);
                if (i < json.Length && json[i] == ':') i++;
                SkipWhitespace(json, ref i);
                string val = ReadValue(json, ref i);
                if (!string.IsNullOrEmpty(key))
                {
                    result[key] = val;
                }
                SkipWhitespace(json, ref i);
                if (i < json.Length && json[i] == ',') i++;
            }

            return result;
        }

        private static void SkipWhitespace(string s, ref int i)
        {
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        }

        private static string ReadString(string s, ref int i)
        {
            SkipWhitespace(s, ref i);
            if (i >= s.Length) return "";

            if (s[i] == '"')
            {
                i++;
                var sb = new StringBuilder();
                while (i < s.Length)
                {
                    char c = s[i++];
                    if (c == '\\' && i < s.Length)
                    {
                        char next = s[i++];
                        switch (next)
                        {
                            case '"': sb.Append('"'); break;
                            case '\\': sb.Append('\\'); break;
                            case 'n': sb.Append('\n'); break;
                            case 'r': sb.Append('\r'); break;
                            case 't': sb.Append('\t'); break;
                            default: sb.Append(next); break;
                        }
                    }
                    else if (c == '"')
                    {
                        break;
                    }
                    else
                    {
                        sb.Append(c);
                    }
                }
                return sb.ToString();
            }

            return ReadBareToken(s, ref i);
        }

        private static string ReadValue(string s, ref int i)
        {
            SkipWhitespace(s, ref i);
            if (i >= s.Length) return "";

            if (s[i] == '"') return ReadString(s, ref i);
            return ReadBareToken(s, ref i);
        }

        private static string ReadBareToken(string s, ref int i)
        {
            int start = i;
            while (i < s.Length && s[i] != ',' && s[i] != '}' && !char.IsWhiteSpace(s[i]))
            {
                i++;
            }
            return s.Substring(start, i - start).Trim();
        }
    }
}
