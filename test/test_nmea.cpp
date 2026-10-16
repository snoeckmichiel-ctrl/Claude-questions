// Test van nmea.h op een gewone computer:
//   g++ -std=c++17 -Wall -Wextra -I firmware/trekker_gps test/test_nmea.cpp -o /tmp/test_nmea && /tmp/test_nmea
#include <cassert>
#include <cstdio>
#include <string>
#include <vector>
#include "nmea.h"

static int failures = 0;
#define CHECK(cond) do { if (!(cond)) { printf("FOUT regel %d: %s\n", __LINE__, #cond); ++failures; } } while (0)

static std::string withChecksum(const std::string& body) {
  char out[200];
  size_t n = nmea::finalize(body.c_str(), body.size(), out, sizeof out);
  return std::string(out, n - 2);  // zonder CRLF
}

static std::vector<std::string> feedAll(const std::string& stream, nmea::LineAssembler& a) {
  std::vector<std::string> lines;
  for (char c : stream) if (a.feed(c)) lines.emplace_back(a.line());
  return lines;
}

int main() {
  // Bekende geldige zin (Wikipedia-voorbeeld).
  const char* gga = "$GPGGA,092750.000,5321.6802,N,00630.3372,W,1,8,1.03,61.7,M,55.2,M,,*76";
  CHECK(nmea::checksumOk(gga));
  CHECK(!nmea::checksumOk("$GPGGA,092750.000,5321.6802,N,00630.3372,W,1,8,1.03,61.7,M,55.2,M,,*77"));
  CHECK(!nmea::checksumOk("GPGGA,1*00"));
  CHECK(nmea::typeOf(gga) == nmea::GGA);
  CHECK(nmea::typeOf("$PAIR001,050,0*3E") == nmea::PROPRIETARY);
  CHECK(nmea::ggaFixQuality(gga) == 1);

  // Commando's: controle met bekende checksum $PAIR050,1000*12.
  char cmd[64];
  size_t n = nmea::buildCommand("PAIR050,1000", cmd, sizeof cmd);
  CHECK(std::string(cmd, n) == "$PAIR050,1000*12\r\n");

  // Velden
  char f[16];
  CHECK(nmea::field(gga, 7, f, sizeof f) && std::string(f) == "8");
  CHECK(nmea::field(gga, 14, f, sizeof f) && std::string(f) == "");

  // Zinnen uit een stroom halen, met rommel, binaire bytes en een kapotte zin.
  nmea::LineAssembler a;
  std::string g1 = withChecksum("GNGGA,120000.00,5100.0000,N,00400.0000,E,4,20,0.6,30.0,M,46.0,M,1.0,0000");
  std::string v1 = withChecksum("GNVTG,45.0,T,,M,5.4,N,10.0,K,R");
  std::string stream = "rommel\xd3\x00\x13" + g1 + "\r\n$GNVTG,kapot*00\r\n" + v1 + "\r\n$GNGG";
  auto lines = feedAll(stream, a);
  CHECK(lines.size() == 2);
  CHECK(lines.size() == 2 && lines[0] == g1 && lines[1] == v1);
  CHECK(a.badLines == 1);
  CHECK(nmea::ggaFixQuality(g1.c_str()) == 4);

  // Amatron-filter: één meting zoals de LC29H die stuurt.
  std::vector<std::string> epoch = {
      withChecksum("GNRMC,120000.00,A,5100.0000,N,00400.0000,E,5.4,45.0,161026,,,R,V"),
      g1,
      withChecksum("GNGSA,A,3,01,02,03,,,,,,,,,,1.2,0.6,1.0,1"),
      withChecksum("GNGSA,A,3,65,66,,,,,,,,,,,1.2,0.6,1.0,2"),
      withChecksum("GNGSA,A,3,301,302,,,,,,,,,,,1.2,0.6,1.0,3"),
      withChecksum("GPGSV,1,1,03,01,40,083,46,02,17,308,41,03,07,344,39"),
      v1,
      withChecksum("GNZDA,120000.00,16,10,2026,00,00"),
      "$PAIR001,050,0*3E",
  };
  nmea::AmatronFilter filt;
  std::vector<std::string> out;
  for (int rep = 0; rep < 2; ++rep) {
    for (auto& l : epoch) {
      char o[200];
      size_t len = filt.process(l.c_str(), o, sizeof o);
      if (len) {
        std::string s(o, len);
        CHECK(s.size() > 2 && s.substr(s.size() - 2) == "\r\n");
        s.resize(s.size() - 2);
        CHECK(nmea::checksumOk(s.c_str()));
        out.push_back(s);
      }
    }
  }
  CHECK(out.size() == 6);  // 2 metingen x (GGA, GSA, VTG)
  if (out.size() == 6) {
    CHECK(out[0].rfind("$GPGGA,", 0) == 0);
    CHECK(out[1] == withChecksum("GPGSA,A,3,01,02,03,,,,,,,,,,1.2,0.6,1.0"));
    CHECK(out[2].rfind("$GPVTG,", 0) == 0);
    CHECK(out[3].rfind("$GPGGA,", 0) == 0);
  }

  // Bandbreedte: 5 Hz moet ruim binnen 19200 baud (1920 bytes/s) passen.
  size_t bytesPerEpoch = 0;
  for (int i = 0; i < 3; ++i) bytesPerEpoch += out[i].size() + 2;
  printf("Bytes per meting naar Amatron: %zu, bij 5 Hz: %zu van 1920 bytes/s\n",
         bytesPerEpoch, bytesPerEpoch * 5);
  CHECK(bytesPerEpoch * 5 < 1920 * 7 / 10);

  // Standaard GSA zonder systeem-ID blijft ongewijzigd, op de talker na.
  nmea::AmatronFilter filt2;
  char o[200];
  std::string gsa17 = withChecksum("GPGSA,A,3,01,02,03,,,,,,,,,,1.2,0.6,1.0");
  size_t len = filt2.process(gsa17.c_str(), o, sizeof o);
  CHECK(len && std::string(o, len - 2) == gsa17);

  // Talker ongewijzigd laten als dat zo ingesteld is.
  nmea::AmatronConfig keep;
  keep.rewriteTalkerToGP = false;
  nmea::AmatronFilter filt3(keep);
  len = filt3.process(g1.c_str(), o, sizeof o);
  CHECK(len && std::string(o, len - 2) == g1);

  if (failures == 0) printf("Alle tests geslaagd.\n");
  return failures ? 1 : 0;
}
