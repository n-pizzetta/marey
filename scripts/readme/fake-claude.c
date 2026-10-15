// A process that only sleeps, built as `claude` and `copilot`, so the live-session checks (`ps -o comm=`) see the simulated sessions as running.
#include <unistd.h>
int main(){sleep(3600);return 0;}
