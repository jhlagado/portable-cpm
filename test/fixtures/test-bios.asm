; Portable CP/M test BIOS.
;
; This is not a machine BIOS. It implements the documented 17-entry CP/M 2.2
; boundary over test-only byte ports so CCP and BDOS can be qualified without
; importing Triptych hardware code.

        ORG     BIOSBAS

CCPBASE EQU     CCPBAS
BDOSENT EQU     BDOSBAS+6
WARMREC EQU     44
TRKRECS EQU     26
RECBYTS EQU     128

SERDATA EQU     $E0
SERSTAT EQU     $E1
DSKSTAT EQU     $E8
DSKDRV  EQU     $E9
DSKREC0 EQU     $EA
DSKREC1 EQU     $EB
DSKREC2 EQU     $EC
DSKREC3 EQU     $ED
DSKDATA EQU     $EE

CMDREAD EQU     1
CMDWRIT EQU     2
CMDFLSH EQU     3

IOBYTE  EQU     $0003
CURDISK EQU     $0004

        JP      COLD
        JP      WARM
        JP      CONST
        JP      CONIN
        JP      CONOUT
        JP      LIST
        JP      PUNCH
        JP      READER
        JP      HOME
        JP      SELDSK
        JP      SETTRK
        JP      SETSEC
        JP      SETDMA
        JP      READ
        JP      WRITE
        JP      LISTST
        JP      SECTRN

COLD:
        DI
        LD      SP,STACKTP
        XOR     A
        LD      (IOBYTE),A
        LD      (CURDISK),A
        LD      C,A
        CALL    PAGEZERO
        JP      CCPBASE

WARM:
        DI
        LD      SP,STACKTP
        XOR     A
        OUT     (DSKDRV),A
        OUT     (DSKREC0),A
        OUT     (DSKREC1),A
        OUT     (DSKREC2),A
        OUT     (DSKREC3),A
        LD      (BOOTREC),A
        LD      A,WARMREC
        LD      (BOOTLEFT),A
        LD      HL,CCPBASE

WARMLOOP:
        LD      A,(BOOTREC)
        OUT     (DSKREC0),A
        LD      A,CMDREAD
        OUT     (DSKSTAT),A
        CALL    WAITRD
        JR      NZ,BOOTFAIL
        LD      B,RECBYTS
        LD      C,DSKDATA
        INIR
        CALL    WAITDONE
        JR      NZ,BOOTFAIL
        LD      A,(BOOTREC)
        INC     A
        LD      (BOOTREC),A
        LD      A,(BOOTLEFT)
        DEC     A
        LD      (BOOTLEFT),A
        JR      NZ,WARMLOOP
        LD      A,(CURDISK)
        LD      C,A
        CALL    PAGEZERO
        JP      CCPBASE

BOOTFAIL:
        HALT
        JR      BOOTFAIL

PAGEZERO:
        LD      A,$C3
        LD      ($0000),A
        LD      HL,WARM
        LD      ($0001),HL
        LD      ($0005),A
        LD      HL,BDOSENT
        LD      ($0006),HL
        RET

CONST:
        IN      A,(SERSTAT)
        AND     1
        RET     Z
        LD      A,$FF
        RET

CONIN:
        CALL    CONST
        OR      A
        JR      Z,CONIN
        IN      A,(SERDATA)
        AND     $7F
        RET

CONOUT:
        LD      A,C
        OUT     (SERDATA),A
        RET

LIST:
PUNCH:
        RET

READER:
        LD      A,$1A
        RET

HOME:
        LD      BC,0

SETTRK:
        LD      (CURTRK),BC
        RET

SELDSK:
        LD      A,C
        OR      A
        LD      HL,0
        RET     NZ
        LD      HL,DPHEAD
        RET

SETSEC:
        LD      (CURSEC),BC
        RET

SETDMA:
        LD      (CURDMA),BC
        RET

READ:
        CALL    SELADDR
        RET     NZ
        LD      A,CMDREAD
        OUT     (DSKSTAT),A
        CALL    WAITRD
        RET     NZ
        LD      HL,(CURDMA)
        LD      B,RECBYTS
        LD      C,DSKDATA
        INIR
        CALL    WAITDONE
        RET

WRITE:
        CALL    SELADDR
        RET     NZ
        LD      A,CMDWRIT
        OUT     (DSKSTAT),A
        CALL    WAITWR
        RET     NZ
        LD      HL,(CURDMA)
        LD      B,RECBYTS
        LD      C,DSKDATA
        OTIR
        CALL    WAITDONE
        RET     NZ
        LD      A,CMDFLSH
        OUT     (DSKSTAT),A
        CALL    WAITIDLE
        RET

SELADDR:
        XOR     A
        OUT     (DSKDRV),A
        LD      HL,(CURTRK)
        LD      D,H
        LD      E,L
        ADD     HL,HL
        ADD     HL,DE
        ADD     HL,HL
        ADD     HL,HL
        ADD     HL,DE
        ADD     HL,HL
        LD      BC,(CURSEC)
        DEC     BC
        ADD     HL,BC
        LD      A,L
        OUT     (DSKREC0),A
        LD      A,H
        OUT     (DSKREC1),A
        XOR     A
        OUT     (DSKREC2),A
        OUT     (DSKREC3),A
        RET

WAITRD:
        IN      A,(DSKSTAT)
        BIT     0,A
        JR      NZ,WAITRD
        BIT     2,A
        JR      NZ,IOERROR
        BIT     1,A
        JR      Z,WAITRD
        XOR     A
        RET

WAITWR:
        IN      A,(DSKSTAT)
        BIT     0,A
        JR      NZ,WAITWR
        BIT     2,A
        JR      NZ,IOERROR
        BIT     1,A
        JR      Z,WAITWR
        XOR     A
        RET

WAITDONE:
        IN      A,(DSKSTAT)
        BIT     0,A
        JR      NZ,WAITDONE
        BIT     2,A
        JR      NZ,IOERROR
        BIT     1,A
        JR      NZ,IOERROR
        XOR     A
        RET

WAITIDLE:
        IN      A,(DSKSTAT)
        BIT     0,A
        JR      NZ,WAITIDLE
        BIT     2,A
        JR      NZ,IOERROR
        XOR     A
        RET

IOERROR:
        LD      A,1
        OR      A
        RET

LISTST:
        XOR     A
        RET

SECTRN:
        LD      H,B
        LD      L,C
        INC     HL
        RET

CURTRK: DW      0
CURSEC: DW      1
CURDMA: DW      $0080
DPHEAD: DW      0,0,0,0,DIRBUF,DPBLOCK,CHKSVEC,ALLOCV
DPBLOCK:
        DW      26
        DB      3,7,0
        DW      242,63
        DB      $C0,0
        DW      16,2
DIRBUF: DS      128,0
CHKSVEC: DS     16,0
ALLOCV: DS      31,0
BOOTREC: DB     0
BOOTLEFT: DB    0
STACK:  DS      64,0
STACKTP:
        DS      BIOSEND-$,0
