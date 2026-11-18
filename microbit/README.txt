마이크로비트 V2.21 · 웹 룰렛 Bluetooth 가속도 서비스

1) https://makecode.microbit.org/ 에서 새 프로젝트
2) 고급 > 확장 > Bluetooth 추가 (radio 확장과 충돌하면 Bluetooth 선택)
3) 프로젝트 설정에서 No Pairing Required 선택
4) JavaScript 편집기에 다음 한 줄만 붙여넣기:

bluetooth.startAccelerometerService()

5) Download > HEX를 USB 연결된 MICROBIT 드라이브에 복사
6) USB로 전원을 공급해도 실행됩니다. 하지만 웹 룰렛의 데이터 수신은 Bluetooth로 진행됩니다.
7) HTTPS 페이지의 마이크로비트 연결 버튼에서 기기를 선택하고, 운영 패널의 센서 수신 횟수와 XYZ 값 확인

중요: USB 연결만으로 룰렛과 데이터 통신이 되는 것은 아닙니다.
실제 기기 블루투스 연결 현장 검증은 별도로 필요합니다.
