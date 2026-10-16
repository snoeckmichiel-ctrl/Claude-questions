// nmea.h - NMEA 0183 hulpfuncties zonder Arduino-afhankelijkheden.
// Kan dus ook op een gewone computer getest worden (zie test/test_nmea.cpp).
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

namespace nmea {

// Maximale lengte van een zin. De standaard zegt 82 tekens, maar moderne
// ontvangers (NMEA 4.10, veel decimalen) gaan daar soms overheen.
static const size_t MAX_LINE = 160;

enum Type { OTHER, GGA, VTG, GSA, RMC, ZDA, GSV, GLL, PROPRIETARY };

inline int hexVal(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return -1;
}

inline uint8_t xorSum(const char* p, size_t len) {
  uint8_t cs = 0;
  for (size_t i = 0; i < len; ++i) cs ^= (uint8_t)p[i];
  return cs;
}

// Controleert een zin zonder CR/LF, bv. "$GPGGA,...*47".
inline bool checksumOk(const char* line) {
  if (!line || line[0] != '$') return false;
  const char* star = strrchr(line, '*');
  if (!star || hexVal(star[1]) < 0 || hexVal(star[2]) < 0 || star[3] != '\0') return false;
  uint8_t want = (uint8_t)(hexVal(star[1]) * 16 + hexVal(star[2]));
  return xorSum(line + 1, (size_t)(star - line - 1)) == want;
}

// Bouwt "$<body>*HH\r\n". Geeft de lengte terug, of 0 als 'out' te klein is.
inline size_t finalize(const char* body, size_t bodyLen, char* out, size_t outSize) {
  if (bodyLen + 7 > outSize) return 0;
  out[0] = '$';
  memcpy(out + 1, body, bodyLen);
  snprintf(out + 1 + bodyLen, outSize - 1 - bodyLen, "*%02X\r\n", xorSum(body, bodyLen));
  return bodyLen + 6;
}

// Maakt een volledig commando, bv. buildCommand("PAIR050,200", ...).
inline size_t buildCommand(const char* body, char* out, size_t outSize) {
  return finalize(body, strlen(body), out, outSize);
}

inline Type typeOf(const char* line) {
  if (!line || line[0] != '$') return OTHER;
  if (line[1] == 'P') return PROPRIETARY;  // $PAIR..., $PQTM...
  if (strlen(line) < 7 || line[6] != ',') return OTHER;
  const char* s = line + 3;  // sla '$' en de twee talker-letters over
  if (!strncmp(s, "GGA", 3)) return GGA;
  if (!strncmp(s, "VTG", 3)) return VTG;
  if (!strncmp(s, "GSA", 3)) return GSA;
  if (!strncmp(s, "RMC", 3)) return RMC;
  if (!strncmp(s, "ZDA", 3)) return ZDA;
  if (!strncmp(s, "GSV", 3)) return GSV;
  if (!strncmp(s, "GLL", 3)) return GLL;
  return OTHER;
}

// Geeft veld nummer 'idx' terug (0 = "$GPGGA"). Leeg veld geeft "".
inline bool field(const char* line, int idx, char* out, size_t outSize) {
  const char* p = line;
  for (int i = 0; i < idx; ++i) {
    p = strchr(p, ',');
    if (!p) return false;
    ++p;
  }
  size_t n = strcspn(p, ",*");
  if (n + 1 > outSize) return false;
  memcpy(out, p, n);
  out[n] = '\0';
  return true;
}

// GGA-kwaliteit: 0 geen fix, 1 GPS, 2 DGPS/SBAS, 4 RTK fixed, 5 RTK float.
inline int ggaFixQuality(const char* line) {
  char f[4];
  if (typeOf(line) != GGA || !field(line, 6, f, sizeof f) || f[0] == '\0') return -1;
  return f[0] - '0';
}

// Zet binnenkomende tekens om in volledige zinnen.
class LineAssembler {
 public:
  // Geeft true als er een volledige zin met geldige checksum klaarstaat.
  bool feed(char c) {
    if (c == '$') {  // nieuw begin, ook als de vorige zin onvolledig was
      len_ = 0;
      active_ = true;
    }
    if (!active_) return false;
    if (c == '\r' || c == '\n') {
      active_ = false;
      buf_[len_] = '\0';
      if (len_ > 0 && checksumOk(buf_)) return true;
      ++badLines;
      return false;
    }
    if (len_ >= MAX_LINE - 1 || c < 0x20 || c > 0x7E) {  // te lang of binair
      active_ = false;
      ++badLines;
      return false;
    }
    buf_[len_++] = c;
    return false;
  }
  const char* line() const { return buf_; }
  size_t length() const { return len_; }
  unsigned long badLines = 0;

 private:
  char buf_[MAX_LINE];
  size_t len_ = 0;
  bool active_ = false;
};

struct AmatronConfig {
  bool gga = true;
  bool vtg = true;
  bool gsa = true;
  bool rmc = false;
  bool zda = false;
  bool rewriteTalkerToGP = true;  // "$GNGGA" wordt "$GPGGA" voor oudere terminals
  bool stripGsaSystemId = true;   // laatste GSA-veld uit NMEA 4.10 weglaten
};

// Kiest welke zinnen naar de Amatron gaan en past ze zo nodig aan.
// Er gaat maximaal één GSA per meting door: bij meerdere satellietsystemen
// stuurt de ontvanger er anders 3 tot 4, en dat past niet in 19200 baud.
class AmatronFilter {
 public:
  explicit AmatronFilter(const AmatronConfig& cfg = AmatronConfig()) : cfg_(cfg) {}

  // Geeft de lengte van de uitgaande zin in 'out' (met CRLF), of 0 = niet sturen.
  size_t process(const char* line, char* out, size_t outSize) {
    Type t = typeOf(line);
    bool keep = false;
    switch (t) {
      case GGA: keep = cfg_.gga; gsaSent_ = false; break;
      case VTG: keep = cfg_.vtg; break;
      case GSA: keep = cfg_.gsa && !gsaSent_; if (keep) gsaSent_ = true; break;
      case RMC: keep = cfg_.rmc; break;
      case ZDA: keep = cfg_.zda; break;
      default: keep = false;
    }
    if (!keep) return 0;

    const char* star = strrchr(line, '*');
    if (!star) return 0;
    size_t bodyLen = (size_t)(star - line - 1);
    if (bodyLen + 1 > MAX_LINE) return 0;
    char body[MAX_LINE];
    memcpy(body, line + 1, bodyLen);
    body[bodyLen] = '\0';

    if (cfg_.rewriteTalkerToGP && body[0] == 'G' && body[1] == 'N') body[1] = 'P';

    if (t == GSA && cfg_.stripGsaSystemId) {
      // Standaard GSA heeft 17 komma's. NMEA 4.10 voegt een systeem-ID toe (18).
      int commas = 0;
      for (size_t i = 0; i < bodyLen; ++i) commas += (body[i] == ',');
      if (commas == 18) {
        char* last = strrchr(body, ',');
        *last = '\0';
        bodyLen = (size_t)(last - body);
      }
    }
    return finalize(body, bodyLen, out, outSize);
  }

 private:
  AmatronConfig cfg_;
  bool gsaSent_ = false;
};

}  // namespace nmea
